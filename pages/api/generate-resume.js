// pages/api/generate-resume.js
// HireEdge — AI CV Generator (JSON + multipart upload)

import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import path from "path";

// we'll lazy-load these because they are heavy
let mammoth; // for .docx
let pdfParse; // for .pdf

// CORS — change if your Framer uses a different domain
const ALLOWED_ORIGIN = "https://hireedge.co.uk";

// tiny helper
const S = (v) => (v ?? "").toString().trim();

// tell Next.js not to parse the body (we do it ourselves)
export const config = {
  api: {
    bodyParser: false,
  },
};

/* ------------------------------------------------------------------ */
/*  Util: build OpenAI client                                          */
/* ------------------------------------------------------------------ */
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/* ------------------------------------------------------------------ */
/*  Some docx helpers                                                  */
/* ------------------------------------------------------------------ */
const label = (txt) =>
  new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text: txt, bold: true })],
  });

const para = (txt) => new Paragraph({ children: [new TextRun(txt)] });

const bullet = (txt) =>
  new Paragraph({
    text: txt,
    bullet: { level: 0 },
  });

/* ------------------------------------------------------------------ */
/*  Extract JD keywords (simple)                                       */
/* ------------------------------------------------------------------ */
function extractKeywordsFromJD(jd = "", limit = 10) {
  if (!jd) return [];
  const words = jd
    .toLowerCase()
    .split(/[^a-z0-9+]+/g)
    .filter(Boolean);

  const stop = new Set([
    "and",
    "the",
    "with",
    "your",
    "you",
    "our",
    "for",
    "that",
    "this",
    "role",
    "will",
    "are",
    "job",
    "description",
    "please",
    "apply",
    "more",
    "information",
    "highly",
    "desirable",
  ]);

  const counts = {};
  for (const w of words) {
    if (stop.has(w)) continue;
    if (w.length < 3) continue;
    counts[w] = (counts[w] || 0) + 1;
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)
    .slice(0, limit);
}

/* ------------------------------------------------------------------ */
/*  Very simple CV text parser — turns big text into "experiences"     */
/* ------------------------------------------------------------------ */
function parseCvText(raw = "") {
  if (!raw) {
    return { experiences: [], education: [] };
  }

  const lines = raw
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const experiences = [];
  const education = [];

  // extremely light heuristic: any line that looks like a job gets added
  let current = null;
  for (const line of lines) {
    // dates like 2021, 2022, 09/2021
    if (/20\d{2}|19\d{2}/.test(line) && line.length < 40) {
      if (current) experiences.push(current);
      current = {
        title: "",
        company: "",
        bullets: [],
        date: line,
      };
      continue;
    }

    if (!current) {
      // maybe header / summary, ignore
      continue;
    }

    if (line.startsWith("•") || line.startsWith("-")) {
      current.bullets.push(line.replace(/^[-•]\s?/, "").trim());
    } else if (!current.title) {
      current.title = line;
    } else if (!current.company) {
      current.company = line;
    } else {
      current.bullets.push(line);
    }
  }
  if (current) experiences.push(current);

  return { experiences, education };
}

/* ------------------------------------------------------------------ */
/*  AI: build summary                                                  */
/* ------------------------------------------------------------------ */
async function buildSummary({ profile, jd, jdKeywords = [], sourceSummary }) {
  const client = getOpenAIClient();
  if (!client) {
    return (
      sourceSummary ||
      `Experienced ${profile.targetTitle || "professional"} aligned to the provided job description.`
    );
  }

  const prompt = `
You are a UK CV writer.
Write a 3–4 sentence professional profile, ATS-friendly, aligned to this job description.
Naturally include some of these keywords if they fit: ${jdKeywords.join(", ")}.
Do not invent achievements.

Candidate name: ${profile.fullName || "Candidate"}
Target role: ${profile.targetTitle || "role"}

Existing top paragraph (may be messy):
"""${sourceSummary || ""}"""

Job description:
"""${jd}"""

Return only the final paragraph.
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.35,
  });

  return resp.choices[0].message.content.trim();
}

/* ------------------------------------------------------------------ */
/*  AI: improve bullets                                                */
/* ------------------------------------------------------------------ */
async function improveBullets({ bullets, jd, jdKeywords = [], roleTitle }) {
  const client = getOpenAIClient();
  if (!client || !bullets.length) return bullets;

  const prompt = `
Rewrite these CV bullet points so they are UK-style, ATS-friendly, and match this job.
Keep them true, don't make up KPIs, but you can add wording.
Include some of these JD keywords if natural: ${jdKeywords.join(", ")}.

Job title: ${roleTitle || "Data Analyst"}

Job description:
"""${jd}"""

Original bullets:
${bullets.map((b) => "- " + b).join("\n")}

Return only the improved bullets, one per line.
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.45,
  });

  const lines = resp.choices[0].message.content
    .split("\n")
    .map((l) => l.replace(/^[-•]\s?/, "").trim())
    .filter(Boolean);

  return lines.length ? lines : bullets;
}

/* ------------------------------------------------------------------ */
/*  Build DOCX                                                         */
/* ------------------------------------------------------------------ */
async function buildDocx({ profile, jd, jdKeywords, cvText }) {
  // parse CV into "experiences"
  const parsed = parseCvText(cvText);
  const experiences = parsed.experiences || [];

  // build summary
  const aiSummary = await buildSummary({
    profile,
    jd,
    jdKeywords,
    sourceSummary: cvText.split("\n").slice(0, 6).join(" "),
  });

  const children = [];

  // header
  if (profile.fullName) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 80 },
        children: [
          new TextRun({ text: profile.fullName, bold: true, size: 40 }),
        ],
      })
    );
  }
  if (profile.targetTitle) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 60 },
        children: [new TextRun({ text: profile.targetTitle, italics: true })],
      })
    );
  }
  const contacts = [profile.email, profile.phone, profile.linkedin].filter(
    Boolean
  );
  if (contacts.length) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun(contacts.join("  |  "))],
      })
    );
  }

  // summary
  children.push(label("PROFILE SUMMARY"));
  children.push(para(aiSummary));

  // skills: from JD keywords
  if (jdKeywords.length) {
    children.push(label("KEY SKILLS"));
    children.push(para(jdKeywords.map((k) => k.toUpperCase()).join(" • ")));
  }

  // experience
  children.push(label("PROFESSIONAL EXPERIENCE"));

  if (experiences.length) {
    for (const role of experiences) {
      const heading = [role.title, role.company].filter(Boolean).join(", ");
      if (heading) {
        children.push(
          new Paragraph({
            spacing: { before: 120, after: 40 },
            children: [new TextRun({ text: heading, bold: true })],
          })
        );
      }

      const improvedBullets = await improveBullets({
        bullets: role.bullets || [],
        jd,
        jdKeywords,
        roleTitle: role.title,
      });

      (improvedBullets || []).forEach((b) => children.push(bullet(b)));
    }
  } else {
    children.push(para("Experience details available on request."));
  }

  // education (we didn't detect much, so put a placeholder)
  children.push(label("EDUCATION"));
  children.push(para("Available on request."));

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: { top: 720, bottom: 720, left: 900, right: 900 },
          },
        },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  const filename = `HireEdge_${(profile.targetTitle || "CV")
    .replace(/[^a-z0-9]+/gi, "_")
    .slice(0, 40)}.docx`;

  return { buffer, filename };
}

/* ------------------------------------------------------------------ */
/*  Parse multipart/form-data (upload)                                 */
/* ------------------------------------------------------------------ */
function parseMultipart(req) {
  const uploadDir = "/tmp";
  const form = formidable({
    multiples: false,
    uploadDir,
    keepExtensions: true,
    maxFileSize: 10 * 1024 * 1024, // 10MB
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

/* ------------------------------------------------------------------ */
/*  MAIN HANDLER                                                       */
/* ------------------------------------------------------------------ */
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "HireEdge AI Resume API alive ✅",
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    let cvText = "";
    let jobDescription = "";
    let email = "";
    let profile = {
      fullName: "",
      targetTitle: "",
      email: "",
      phone: "",
      linkedin: "",
    };

    const contentType = req.headers["content-type"] || "";

    /* -------------------- 1) multipart = upload CV ----------------- */
    if (contentType.startsWith("multipart/form-data")) {
      const { fields, files } = await parseMultipart(req);

      jobDescription = S(fields.jobDescription || fields.jd);
      email = S(fields.email);

      // read file
      const file = files.cv || files.file || null;

      if (file && file.filepath) {
        const ext = path.extname(file.originalFilename || file.newFilename || "")
          .toLowerCase()
          .replace(".", "");

        // lazy-load heavy libs
        if (ext === "docx") {
          if (!mammoth) {
            mammoth = (await import("mammoth")).default;
          }
          const buf = fs.readFileSync(file.filepath);
          const result = await mammoth.extractRawText({ buffer: buf });
          cvText = result.value || "";
        } else if (ext === "pdf") {
          if (!pdfParse) {
            pdfParse = (await import("pdf-parse")).default;
          }
          const buf = fs.readFileSync(file.filepath);
          const result = await pdfParse(buf);
          cvText = result.text || "";
        } else {
          // fallback: just read as text
          cvText = fs.readFileSync(file.filepath, "utf8");
        }

        // remove temp file
        fs.unlink(file.filepath, () => {});
      } else {
        // no file → just use fields
        cvText = S(fields.cvText || fields.oldCvText || "");
      }

      profile = {
        fullName: S(fields.fullName),
        targetTitle: S(fields.targetTitle),
        email,
      };
    }
    /* -------------------- 2) JSON = pasted CV ---------------------- */
    else {
      // bodyParser is off, so we need to read the raw body ourselves
      const raw = await new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => {
          data += chunk;
        });
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });

      const body = raw ? JSON.parse(raw) : {};

      cvText =
        S(body.cvText) ||
        S(body.oldCvText) ||
        S(body.pastedCv) ||
        S(body.cv) ||
        "";
      jobDescription = S(body.jobDescription || body.jd);
      email = S(body.email);

      profile = {
        fullName: S(body.fullName || body?.profile?.fullName),
        targetTitle: S(body.targetTitle || body?.profile?.targetTitle),
        email,
        phone: S(body.phone || body?.profile?.phone),
        linkedin: S(body.linkedin || body?.profile?.linkedin),
      };
    }

    const jdKeywords = extractKeywordsFromJD(jobDescription, 12);

    const { buffer, filename } = await buildDocx({
      profile,
      jd: jobDescription,
      jdKeywords,
      cvText,
    });

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(filename)}"`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );

    return res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error("❌ AI resume generation failed:", err);
    return res.status(500).json({
      error: "AI resume generation failed",
      details: String(err),
    });
  }
}
