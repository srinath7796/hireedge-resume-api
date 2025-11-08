// pages/api/generate-resume.js
// HireEdge – CV generator (paste OR file upload)

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

let mammoth;   // lazy load
let pdfParse;  // lazy load

const ALLOWED_ORIGIN = "https://hireedge.co.uk"; // change if needed
const S = (v) => (v ?? "").toString().trim();

// tell Next.js not to parse this automatically – we handle form-data
export const config = {
  api: {
    bodyParser: false,
  },
};

// --------- helpers for docx layout ----------

const centerHeading = (txt, size = 40, bold = true) =>
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
    children: [new TextRun({ text: txt, bold, size })],
  });

const sectionLabel = (txt) =>
  new Paragraph({
    spacing: { before: 300, after: 80 },
    children: [new TextRun({ text: txt, bold: true, size: 24 })],
  });

const p = (txt) =>
  new Paragraph({
    children: [new TextRun(txt)],
  });

const bullet = (txt) =>
  new Paragraph({
    text: txt,
    bullet: { level: 0 },
  });

// small jd keyword extractor
function extractKeywordsFromJD(jd = "", limit = 10) {
  if (!jd) return [];
  const bad = new Set([
    "and",
    "the",
    "for",
    "with",
    "will",
    "you",
    "your",
    "our",
    "team",
    "role",
    "job",
    "description",
    "please",
    "apply",
    "more",
    "information",
  ]);
  const counts = {};
  jd
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter(Boolean)
    .forEach((w) => {
      if (w.length < 3) return;
      if (bad.has(w)) return;
      counts[w] = (counts[w] || 0) + 1;
    });

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)
    .slice(0, limit);
}

// try to get OpenAI client
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// build profile summary with AI, else fallback
async function buildSummary({ name, targetTitle, jd, pastedSummary, jdKeywords }) {
  const client = getOpenAIClient();
  if (!client) {
    return (
      pastedSummary ||
      `Analytical and results-driven professional aligned to the provided job description.`
    );
  }

  const prompt = `
You are a UK CV writer.

Write a 3–4 sentence PROFILE SUMMARY for this candidate. 
Keep the candidate's existing info but make it more professional and ATS-friendly.
Naturally include relevant keywords from the job description.
Do NOT invent fake achievements or companies.

Candidate:
- Name: ${name || "Candidate"}
- Target title: ${targetTitle || "Data Analyst"}

Existing text:
"""${pastedSummary || ""}"""

Job description:
"""${jd || ""}"""

Return only the summary text.
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.45,
  });

  return resp.choices[0].message.content.trim();
}

// generate bullets if none
async function buildBulletsForRole({ roleTitle, jd, jdKeywords }) {
  const client = getOpenAIClient();
  if (!client) {
    return [
      "Managed and analysed business data to support decision-making.",
      "Collaborated with stakeholders to resolve data issues.",
    ];
  }

  const prompt = `
Write 4 CV bullet points in UK English for role "${roleTitle || "Data Analyst"}".
Make them ATS-friendly and aligned to this job description.
Use some of these keywords if natural: ${jdKeywords.join(", ")}
Do not invent fake metrics.

JD:
"""${jd}"""
`;
  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.5,
  });

  return resp.choices[0].message.content
    .split("\n")
    .map((l) => l.replace(/^[-•]\s?/, "").trim())
    .filter(Boolean)
    .slice(0, 4);
}

// parse pasted CV into some structure (very loose)
function parsePastedCv(text = "") {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const name = lines[0] || "";
  // we just dump the rest under "experience", your AI will rewrite
  return {
    name,
    raw: text,
  };
}

// read uploaded file (.docx or .pdf) into text
async function readUploadedFile(filePath, mime) {
  if (!filePath) return "";
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".docx") {
    if (!mammoth) {
      mammoth = (await import("mammoth")).default;
    }
    const { value } = await mammoth.extractRawText({ path: filePath });
    return value;
  }

  if (ext === ".pdf") {
    if (!pdfParse) {
      pdfParse = (await import("pdf-parse")).default;
    }
    const dataBuffer = fs.readFileSync(filePath);
    const res = await pdfParse(dataBuffer);
    return res.text;
  }

  // fallback plain text
  return fs.readFileSync(filePath, "utf8");
}

// ------------------ main handler ------------------

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "HireEdge API live ✅" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // detect if this is multipart (upload tab) or json (paste tab)
    const contentType = req.headers["content-type"] || "";

    let cvText = "";
    let jdText = "";
    let userEmail = "";

    if (contentType.startsWith("multipart/form-data")) {
      // -------- upload mode --------
      const form = formidable({ multiples: false });
      const { fields, files } = await new Promise((resolve, reject) => {
        form.parse(req, (err, fields, files) => {
          if (err) reject(err);
          else resolve({ fields, files });
        });
      });

      jdText = S(fields.jobDescription || fields.jd || "");
      userEmail = S(fields.email || "");

      if (files.cv) {
        const file = files.cv;
        const filePath = Array.isArray(file) ? file[0].filepath : file.filepath;
        const mime = Array.isArray(file) ? file[0].mimetype : file.mimetype;
        cvText = await readUploadedFile(filePath, mime);
      } else {
        cvText = S(fields.oldCvText || "");
      }
    } else {
      // -------- paste mode (JSON) --------
      const body =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      cvText = S(body.cvText || body.oldCvText || "");
      jdText = S(body.jobDescription || body.jd || "");
      userEmail = S(body.email || "");
    }

    // at this point we should have cvText (maybe long) + jdText
    const jdKeywords = extractKeywordsFromJD(jdText, 12);

    // try to guess name
    const parsed = parsePastedCv(cvText);
    const fullName = parsed.name || "Candidate";

    // Build summary with AI
    const aiSummary = await buildSummary({
      name: fullName,
      targetTitle: "Data Analyst",
      jd: jdText,
      pastedSummary: "",
      jdKeywords,
    });

    // Experience – for now we generate 1 block from JD
    const bullets = await buildBulletsForRole({
      roleTitle: "Data Analyst",
      jd: jdText,
      jdKeywords,
    });

    // Education – you can extract later; for now hardcode placeholder
    const educationLines = [
      "MSc Data Science – University name, 2024",
      "BEng / BSc – Institution, Year",
    ];

    // Skills – merge jd keywords
    const baseSkills = [
      "SQL",
      "Python",
      "Data Analysis",
      "Data Visualization",
      "Stakeholder Management",
    ];
    const allSkills = Array.from(
      new Set([...baseSkills, ...jdKeywords.map((k) => k.toUpperCase())])
    ).slice(0, 14);

    // ------------ build DOCX ------------
    const doc = new Document({
      sections: [
        {
          properties: {
            page: {
              margin: { top: 720, right: 720, bottom: 720, left: 720 },
            },
          },
          children: [
            centerHeading(fullName, 40, true),
            centerHeading("London • " + (userEmail || "email available"), 24, false),

            sectionLabel("PROFILE SUMMARY"),
            p(aiSummary),

            sectionLabel("KEY SKILLS"),
            p(allSkills.join(" • ")),

            sectionLabel("PROFESSIONAL EXPERIENCE"),
            p("Data Analyst | Company Name, London"),
            p("2018 – Present"),
            ...bullets.map((b) => bullet(b)),

            sectionLabel("EDUCATION"),
            ...educationLines.map((e) => p(e)),
          ],
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);
    const filename = `HireEdge_CV.docx`;

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
    console.error("❌ API error:", err);
    return res
      .status(500)
      .json({ error: "AI resume generation failed", details: String(err) });
  }
}
