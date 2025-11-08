// pages/api/generate-resume.js
// HireEdge — AI CV Generator (paste OR upload)

import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import formidable from "formidable";

const ALLOWED_ORIGIN = "https://hireedge.co.uk"; // change if you publish under www.

const S = (v) => (v ?? "").toString().trim();

// tell Next.js NOT to parse the body (so formidable can read multipart)
export const config = {
  api: {
    bodyParser: false,
  },
};

// make OpenAI client only if key exists
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/* -------------------------------------------------------------------------- */
/* small docx helpers                                                         */
/* -------------------------------------------------------------------------- */
const label = (txt) =>
  new Paragraph({
    spacing: { before: 220, after: 80 },
    children: [new TextRun({ text: txt, bold: true })],
  });

const para = (txt) => new Paragraph({ children: [new TextRun(txt)] });

const bullet = (txt) => new Paragraph({ text: txt, bullet: { level: 0 } });

/* -------------------------------------------------------------------------- */
/* JD keyword extraction – safer                                              */
/* -------------------------------------------------------------------------- */
function extractKeywordsFromJD(jd = "", limit = 10) {
  if (!jd) return [];
  const words = jd.toLowerCase().split(/[^a-z0-9+]+/).filter(Boolean);

  // things we never want in skills
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
    "role",
    "team",
    "looking",
    "join",
    "salary",
    "bonus",
    "london",
    "client",
    "skills",
    "data",          // too generic, you’re a data analyst anyway
    "analyst",
    "job",
    "description",
    "please",
    "apply",
    "asap",
    "more",
    "information",
    "years",
    "experience",
    "required",
  ]);

  const counts = {};
  for (const w of words) {
    if (bad.has(w)) continue;
    if (/^\d+$/.test(w)) continue; // drop pure numbers like 65,000
    if (w.length < 3) continue;
    counts[w] = (counts[w] || 0) + 1;
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)
    .slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* very simple pasted-CV parser                                               */
/* -------------------------------------------------------------------------- */
function parseOldCvSmart(raw = "") {
  const text = raw.replace(/\r/g, "\n");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const experiences = [];
  const education = [];

  // very loose: look for lines that look like job titles
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // detect education keywords
    if (/bachelor|master|msc|education|university|college/i.test(line)) {
      education.push({ degree: line });
      continue;
    }

    // detect experience block
    if (
      /analyst|manager|executive|engineer|developer|consultant/i.test(line) &&
      !/summary|profile/i.test(line)
    ) {
      // next few lines that start with dot/bullet
      const bullets = [];
      let j = i + 1;
      while (j < lines.length && (/^[-•]/.test(lines[j]) || lines[j].length < 80)) {
        // stop if it looks like a new section
        if (/^profile|^summary|^education|^skills/i.test(lines[j])) break;
        bullets.push(lines[j].replace(/^[-•]\s?/, "").trim());
        j++;
      }

      experiences.push({
        title: line,
        company: "",
        location: "",
        start: "",
        end: "",
        bullets,
      });
      i = j - 1;
    }
  }

  return { experiences, education };
}

/* -------------------------------------------------------------------------- */
/* AI helpers                                                                 */
/* -------------------------------------------------------------------------- */
async function buildSummary({ profile, jd, sourceSummary, jdKeywords = [] }) {
  const client = getOpenAIClient();
  if (!client) {
    // fallback summary
    return (
      sourceSummary ||
      `Results-driven Data Analyst aligned to the provided job description.`
    );
  }

  const prompt = `
You are a UK CV writer.

Rewrite this summary into 3–4 sentences, ATS-friendly, aligned to this job description.
Use some of these JD keywords only if they fit: ${jdKeywords.join(", ")}.
Do NOT invent achievements.

Current summary:
"""${sourceSummary || ""}"""

Job description:
"""${jd}"""

Candidate:
- Name: ${profile.fullName || "Candidate"}
- Target role: ${profile.targetTitle || "Data Analyst"}
- Current skills: ${profile.topSkills || "N/A"}

Return only the final paragraph.`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.35,
  });

  return resp.choices[0].message.content.trim();
}

async function enhanceOrCreateBullets({ role, jd, jdKeywords, profile }) {
  const client = getOpenAIClient();

  // if user bullets exist, polish them
  if (role.bullets && role.bullets.length) {
    if (!client) return role.bullets;
    const prompt = `
Rewrite these CV bullets so they are UK-style, concise, and aligned to the JD.
Keep them truthful (no fake metrics).
If natural, include: ${jdKeywords.join(", ")}.

Bullets:
${role.bullets.map((b) => "- " + b).join("\n")}

Job description:
${jd}

Return only bullets, one per line.`;
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.45,
    });
    return resp.choices[0].message.content
      .split("\n")
      .map((l) => l.replace(/^[-•]\s?/, "").trim())
      .filter(Boolean);
  }

  // no bullets → create from JD
  if (!client) {
    return [
      "Analysed datasets to support trading and quantitative teams.",
      "Collaborated with stakeholders to improve data quality.",
    ];
  }

  const prompt = `
Write 4 CV bullet points for a Data Analyst in a FinTech / trading environment.
Align them to this JD:
${jd}

Include some of: ${jdKeywords.join(", ")} if it makes sense.
No fake numbers.`;

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

/* -------------------------------------------------------------------------- */
/* main handler                                                               */
/* -------------------------------------------------------------------------- */
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "HireEdge API alive ✅" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    let mode = "paste"; // default
    let pastedCvText = "";
    let jd = "";
    let email = "";
    let fileText = "";

    // check content-type
    const contentType = req.headers["content-type"] || "";

    if (contentType.startsWith("multipart/form-data")) {
      // --------- UPLOAD MODE ----------
      const form = formidable({
        multiples: false,
        keepExtensions: true,
      });

      const { fields, files } = await new Promise((resolve, reject) => {
        form.parse(req, (err, fields, files) => {
          if (err) reject(err);
          else resolve({ fields, files });
        });
      });

      mode = "upload";
      jd = S(fields.jobDescription);
      email = S(fields.email);

      const cvFile = files.cv || files.file;
      if (cvFile) {
        const filePath = cvFile.filepath || cvFile.path;
        const ext = path.extname(cvFile.originalFilename || "").toLowerCase();

        if (ext === ".docx") {
          const mammoth = await import("mammoth");
          const buff = fs.readFileSync(filePath);
          const result = await mammoth.extractRawText({ buffer: buff });
          fileText = result.value;
        } else if (ext === ".pdf") {
          const pdfParse = (await import("pdf-parse")).default;
          const buff = fs.readFileSync(filePath);
          const result = await pdfParse(buff);
          fileText = result.text;
        } else {
          // txt or unknown → just read as text
          fileText = fs.readFileSync(filePath, "utf8");
        }
      }
    } else {
      // --------- PASTE MODE ----------
      const body =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      mode = body.mode || "paste";
      pastedCvText = S(body.cvText || body.oldCvText || body.currentCv);
      jd = S(body.jd || body.jobDescription);
      email = S(body.email);
    }

    // now we have: mode, pastedCvText, fileText, jd, email
    const rawCv = mode === "upload" ? fileText : pastedCvText;

    // parse CV into experience + education
    let { experiences, education } = parseOldCvSmart(rawCv);

    // if upload gave us nothing, make a fallback experience from JD
    if (!experiences.length) {
      experiences = [
        {
          title: "Data Analyst – FinTech",
          company: "Confidential",
          location: "London, UK",
          start: "",
          end: "",
          bullets: [],
        },
      ];
    }

    const profile = {
      fullName: "", // pasted CV didn’t have it in a consistent line
      targetTitle: "Data Analyst",
      email,
      topSkills: "",
    };

    // get JD keywords
    const jdKeywords = extractKeywordsFromJD(jd, 12);

    // build summary (use top of pasted CV as sourceSummary)
    const sourceSummary = rawCv.split("\n").slice(0, 8).join(" ");
    const aiSummary = await buildSummary({
      profile,
      jd,
      sourceSummary,
      jdKeywords,
    });

    // build docx
    const children = [];

    // header (keep simple)
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 80 },
        children: [
          new TextRun({
            text: profile.fullName || "Candidate Name",
            bold: true,
            size: 40,
          }),
        ],
      })
    );

    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun(profile.targetTitle)],
      })
    );

    // SUMMARY
    children.push(label("PROFILE SUMMARY"));
    children.push(para(aiSummary));

    // SKILLS – merge JD keywords
    if (jdKeywords.length) {
      children.push(label("KEY SKILLS"));
      children.push(
        para(
          jdKeywords
            .map((w) => w.replace(/^\w/, (c) => c.toUpperCase()))
            .slice(0, 14)
            .join(" • ")
        )
      );
    }

    // EXPERIENCE
    children.push(label("PROFESSIONAL EXPERIENCE"));
    for (const role of experiences) {
      const head = [role.title, role.company].filter(Boolean).join(", ");
      if (head) {
        children.push(
          new Paragraph({
            spacing: { before: 140, after: 40 },
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

      const fixedBullets = await enhanceOrCreateBullets({
        role,
        jd,
        jdKeywords,
        profile,
      });
      fixedBullets.forEach((b) => children.push(bullet(b)));
    }

    // EDUCATION
    children.push(label("EDUCATION"));
    if (education.length) {
      education.forEach((e) => {
        const line = [e.degree, e.institution, e.year]
          .filter(Boolean)
          .join(", ");
        children.push(para(line));
      });
    } else {
      children.push(para("Education details available on request."));
    }

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
    const filename = `HireEdge_Data_Analyst_CV.docx`;

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
    console.error("❌ HireEdge API error:", err);
    return res.status(500).json({
      error: "AI resume generation failed",
      details: String(err),
    });
  }
}
