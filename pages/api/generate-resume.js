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

// we will lazy-import these because they are heavy
let mammoth; // for .docx
let pdfParse; // for .pdf

const ALLOWED_ORIGIN = "https://hireedge.co.uk"; // change if needed
const S = (v) => (v ?? "").toString().trim();

// disable Next.js default body parsing for this route
export const config = {
  api: {
    bodyParser: false,
  },
};

// create client only if key exists
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// small docx helpers
const label = (txt) =>
  new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text: txt, bold: true })],
  });
const para = (txt) => new Paragraph({ children: [new TextRun(txt)] });
const bullet = (txt) => new Paragraph({ text: txt, bullet: { level: 0 } });

/**
 * Better JD keyword extractor
 */
function extractKeywordsFromJD(jd = "", limit = 10) {
  if (!jd) return [];
  const words = jd.toLowerCase().split(/[^a-z0-9+]+/).filter(Boolean);
  const bad = new Set([
    "and",
    "the",
    "for",
    "with",
    "your",
    "you",
    "our",
    "their",
    "will",
    "able",
    "work",
    "role",
    "team",
    "looking",
    "join",
    "growing",
    "environment",
    "experience",
    "service",
    "customer",
    "support",
    "provide",
    "required",
    "essential",
    "previous",
    "contact",
    "centre",
    "center",
    "must",
    "job",
    "description",
  ]);

  const counts = {};
  for (const w of words) {
    if (bad.has(w)) continue;
    if (w.length < 4) continue;
    counts[w] = (counts[w] || 0) + 1;
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)
    .slice(0, limit);
}

// parse pasted CV into experience + education
function parseOldCvSmart(raw = "") {
  const text = raw.replace(/\r/g, "\n");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const experiences = [];
  const education = [];

  const dateHeaderRe =
    /^(\d{2}\/\d{4})\s+(to|-)\s+(Present|\d{2}\/\d{4})/i;
  const eduDateRe = /^(\d{2}\/\d{4})\s+/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (dateHeaderRe.test(line)) {
      const m = line.match(dateHeaderRe);
      const start = m[1];
      const end = m[3];
      const title = lines[i + 1] || "";
      const company = lines[i + 2] || "";
      const bulletsArr = [];
      let j = i + 3;
      while (j < lines.length && lines[j].startsWith("•")) {
        bulletsArr.push(lines[j].replace(/^•\s?/, "").trim());
        j++;
      }
      experiences.push({
        title: S(title),
        company: S(company),
        location: "",
        start,
        end,
        bullets: bulletsArr,
      });
      i = j;
      continue;
    }

    if (eduDateRe.test(line)) {
      const m = line.match(eduDateRe);
      const year = m[1].slice(3);
      const degree = line.replace(eduDateRe, "").trim();
      const institution = lines[i + 1] || "";
      education.push({
        degree: S(degree),
        institution: S(institution),
        year: S(year),
      });
      i = i + 2;
      continue;
    }

    i++;
  }

  return { experiences, education };
}

async function buildSummary({ profile, jd, sourceSummary, jdKeywords = [] }) {
  const client = getOpenAIClient();
  if (!client) {
    return (
      sourceSummary ||
      `Experienced ${profile.targetTitle || "professional"} aligned to the provided job description.`
    );
  }

  const prompt = `
You are a UK CV writer.
Rewrite this PROFILE SUMMARY so it is 3–4 sentences, ATS-friendly, and aligned to the job description.
Try to naturally include these JD keywords if they fit: ${jdKeywords.join(", ")}
Do NOT invent achievements.

Existing summary:
"""${sourceSummary || ""}"""

JD:
"""${jd}"""
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.35,
  });

  return resp.choices[0].message.content.trim();
}

async function buildBulletsForRole({ role, jd, profile, jdKeywords = [] }) {
  const client = getOpenAIClient();
  if (!client) {
    return [
      "Maintained strong client and stakeholder relationships.",
      "Supported business operations in a fast-paced setting.",
    ];
  }

  const prompt = `
Write 4 resume bullet points (UK English) for this role. No fake numbers.
Align with this JD:
"""${jd}"""
Try to echo these JD keywords if natural: ${jdKeywords.join(", ")}

Role: ${role.title || "Data / Ops / Admin"}
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.55,
  });

  return resp.choices[0].message.content
    .split("\n")
    .map((l) => l.replace(/^[-•]\s?/, "").trim())
    .filter(Boolean)
    .slice(0, 4);
}

async function enhanceExistingBullets({ bullets, role, jd, jdKeywords = [] }) {
  const client = getOpenAIClient();
  if (!client) return bullets;

  const prompt = `
Rewrite these bullets for a UK CV.
Keep them true.
Align to this JD and try to add: ${jdKeywords.join(", ")}
JD:
"""${jd}"""

Bullets:
${bullets.map((b) => "- " + b).join("\n")}
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.45,
  });

  const rewritten = resp.choices[0].message.content
    .split("\n")
    .map((l) => l.replace(/^[-•]\s?/, "").trim())
    .filter(Boolean);

  return rewritten.length ? rewritten : bullets;
}

/**
 * helper: parse multipart with formidable
 */
function parseMultipart(req) {
  const form = formidable({
    multiples: false,
    maxFileSize: 15 * 1024 * 1024, // 15MB
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

/**
 * helper: extract text from uploaded file
 */
async function extractTextFromFile(file) {
  if (!file) return "";

  const ext = path.extname(file.originalFilename || file.newFilename || "").toLowerCase();

  // docx
  if (ext === ".docx") {
    if (!mammoth) {
      mammoth = await import("mammoth");
    }
    const buf = fs.readFileSync(file.filepath);
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value || "";
  }

  // pdf
  if (ext === ".pdf") {
    if (!pdfParse) {
      pdfParse = (await import("pdf-parse")).default;
    }
    const buf = fs.readFileSync(file.filepath);
    const data = await pdfParse(buf);
    return data.text || "";
  }

  // txt or unknown → just read
  return fs.readFileSync(file.filepath, "utf8");
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "HireEdge API alive ✅" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    let mode = "manual"; // paste mode
    let jd = "";
    let oldCvText = "";
    let profile = {};

    // 1) detect multipart
    const contentType = req.headers["content-type"] || "";
    if (contentType.startsWith("multipart/form-data")) {
      // ---- UPLOAD MODE ----
      const { fields, files } = await parseMultipart(req);

      mode = "cv"; // we uploaded a cv
      jd = S(fields.jobDescription || fields.jd || "");
      profile.email = S(fields.email || fields.userEmail || "");

      // extract text
      const file = files.cv || files.file || files.upload;
      if (file) {
        oldCvText = await extractTextFromFile(file);
      }
    } else {
      // ---- JSON / PASTE MODE ----
      const body =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

      mode = body.mode === "cv" ? "cv" : "manual";
      jd = S(body.jd || body.jobDescription);
      oldCvText = S(body.oldCvText || body.cvText || body.old_cv_text);

      profile = {
        fullName: S(body.fullName),
        targetTitle: S(body.targetTitle),
        email: S(body.email),
        phone: S(body.phone),
        linkedin: S(body.linkedin),
        topSkills: S(body.topSkills),
      };
    }

    // extract JD keywords
    const jdKeywords = extractKeywordsFromJD(jd, 10);

    // parse cv if we have text
    let experiences = [];
    let education = [];
    if (oldCvText) {
      const parsed = parseOldCvSmart(oldCvText);
      experiences = parsed.experiences;
      education = parsed.education;
    }

    // build summary
    const aiSummary = await buildSummary({
      profile,
      jd,
      sourceSummary: oldCvText.split("\n").slice(0, 8).join(" "),
      jdKeywords,
    });

    // start building docx
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
    const contact = [profile.email, profile.phone, profile.linkedin].filter(
      Boolean
    );
    if (contact.length) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 220 },
          children: [new TextRun(contact.join("  |  "))],
        })
      );
    }

    // summary
    children.push(label("PROFILE SUMMARY"));
    children.push(para(aiSummary));

    // skills
    const userSkills = profile.topSkills
      ? profile.topSkills.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const mergedSkills = Array.from(
      new Set([
        ...userSkills,
        ...jdKeywords.map((k) => k.replace(/^\w/, (c) => c.toUpperCase())),
      ])
    );
    if (mergedSkills.length) {
      children.push(label("KEY SKILLS"));
      children.push(para(mergedSkills.slice(0, 14).join(" • ")));
    }

    // experience
    children.push(label("PROFESSIONAL EXPERIENCE"));
    if (experiences.length) {
      for (const role of experiences) {
        const head = [role.title, role.company].filter(Boolean).join(", ");
        if (head) {
          children.push(
            new Paragraph({
              spacing: { before: 120, after: 40 },
              children: [new TextRun({ text: head, bold: true })],
            })
          );
        }

        const sub = [
          role.location,
          [role.start, role.end].filter(Boolean).join(" – "),
        ]
          .filter(Boolean)
          .join("  |  ");
        if (sub) children.push(para(sub));

        let bulletsArr = role.bullets || [];
        if (bulletsArr.length) {
          bulletsArr = await enhanceExistingBullets({
            bullets: bulletsArr,
            role,
            jd,
            jdKeywords,
          });
        } else {
          bulletsArr = await buildBulletsForRole({
            role,
            jd,
            profile,
            jdKeywords,
          });
        }

        bulletsArr.forEach((b) => children.push(bullet(b)));
      }
    } else {
      children.push(para("Experience details available on request."));
    }

    // education
    children.push(label("EDUCATION"));
    if (education.length) {
      education.forEach((e) => {
        const line = [e.degree, e.institution, e.year]
          .filter(Boolean)
          .join(", ");
        if (line) children.push(para(line));
      });
    } else {
      children.push(para("Education details available on request."));
    }

    const doc = new Document({
      sections: [
        {
          properties: {
            page: { margin: { top: 720, bottom: 720, left: 900, right: 900 } },
          },
          children,
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);
    const filename = `HireEdge_${(profile.targetTitle || "CV").replace(
      /[^a-z0-9]+/gi,
      "_"
    )}.docx`;

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
    return res
      .status(500)
      .json({ error: "AI resume generation failed", details: String(err) });
  }
}
