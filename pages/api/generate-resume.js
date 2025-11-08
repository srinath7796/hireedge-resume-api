// pages/api/generate-resume.js
// HireEdge – final version with upload fix

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

// lazy imports for heavy parsers
let mammoth;   // .docx
let pdfParse;  // .pdf

const ALLOWED_ORIGIN = "https://hireedge.co.uk"; // your site
const S = (v) => (v ?? "").toString().trim();

// allow multipart
export const config = {
  api: {
    bodyParser: false,
  },
};

/* ============= OpenAI client ============= */
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/* ============= docx helpers ============= */
const centerHeading = (txt, size = 40) =>
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
    children: [new TextRun({ text: txt, bold: true, size })],
  });

const centerLine = (txt) =>
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
    children: [new TextRun(txt)],
  });

const label = (txt) =>
  new Paragraph({
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text: txt, bold: true })],
  });

const para = (txt) => new Paragraph({ children: [new TextRun(txt)] });
const bullet = (txt) => new Paragraph({ text: txt, bullet: { level: 0 } });

/* ============= parse pasted CV (fix “1”) ============= */
function parsePastedCvImproved(raw = "") {
  const txt = raw.replace(/\r/g, "\n");
  const lines = txt
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // 1) find a line that looks like a real name
  let fullName = "Candidate";
  for (const line of lines) {
    const lower = line.toLowerCase();
    const onlyDigits = /^[0-9. ]+$/.test(line);
    const isPage = lower.startsWith("page ");
    if (onlyDigits || isPage) continue;
    fullName = line;
    break;
  }

  // 2) contact line = next non-empty non-number line
  let contactLine = "";
  const nameIndex = lines.indexOf(fullName);
  for (let i = nameIndex + 1; i < lines.length; i++) {
    const l = lines[i];
    const onlyDigits = /^[0-9. ]+$/.test(l);
    if (!l || onlyDigits) continue;
    contactLine = l;
    break;
  }

  const summaryMatch = txt.match(/summary\s*\n([\s\S]*?)(experience|work experience|employment|education|skills|$)/i);
  const summaryText = summaryMatch ? summaryMatch[1].trim() : "";

  const expMatch = txt.match(/(experience|work experience|employment)\s*\n([\s\S]*?)(education|skills|certifications|$)/i);
  const expText = expMatch ? expMatch[2].trim() : "";

  const eduMatch = txt.match(/education\s*\n([\s\S]*?)$/i);
  const eduText = eduMatch ? eduMatch[1].trim() : "";

  return { fullName, contactLine, summaryText, expText, eduText };
}

/* ============= read uploaded file ============= */
async function readUploadedFile(file) {
  const ext = path.extname(file.originalFilename || "").toLowerCase();

  if (ext === ".docx") {
    if (!mammoth) {
      mammoth = (await import("mammoth")).default;
    }
    const result = await mammoth.extractRawText({ path: file.filepath });
    return result.value || "";
  }

  if (ext === ".pdf") {
    if (!pdfParse) {
      pdfParse = (await import("pdf-parse")).default;
    }
    const buffer = fs.readFileSync(file.filepath);
    const data = await pdfParse(buffer);
    return data.text || "";
  }

  // fallback
  return fs.readFileSync(file.filepath, "utf8");
}

/* ============= AI helpers (token-safe) ============= */
const MAX_CV_CHARS = 6000;
const MAX_JD_CHARS = 4000;

async function aiSummary({ summaryText, jdText }) {
  const client = getOpenAIClient();
  const safeSummary = (summaryText || "").slice(0, 1200);
  const safeJD = (jdText || "").slice(0, 1200);

  if (!client) {
    return (
      safeSummary ||
      "Results-driven professional with strong client-facing, sales and relationship skills, now tailored to the target role."
    );
  }

  const prompt = `
You are a UK CV writer.
Rewrite the candidate profile into 3–4 sentences, ATS-friendly and aligned to the job description.
Keep it truthful. No fake employers or achievements.

Candidate profile:
"""${safeSummary}"""

Job description:
"""${safeJD}"""

Return only the summary.
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.35,
  });

  return resp.choices[0].message.content.trim();
}

async function aiExperience({ expText, jdText }) {
  const client = getOpenAIClient();
  const safeExp = (expText || "").slice(0, MAX_CV_CHARS);
  const safeJD = (jdText || "").slice(0, 1200);

  if (!client) return safeExp;

  const prompt = `
Rewrite this EXPERIENCE section so it:
- keeps the same real jobs, titles and companies
- makes bullets more impact / ownership oriented
- aligns to the job description
- UK CV tone

Candidate EXPERIENCE:
"""${safeExp}"""

Job description:
"""${safeJD}"""

Return only the experience text.
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.45,
  });

  return resp.choices[0].message.content.trim();
}

async function aiSkills({ cvText, jdText }) {
  const client = getOpenAIClient();
  const safeCV = (cvText || "").slice(0, 1500);
  const safeJD = (jdText || "").slice(0, 1000);

  if (!client) {
    return "Sales • Customer Service • Relationship Building • Stakeholder Management • Reporting • Time Management";
  }

  const prompt = `
From the candidate CV and job description, produce one line of 10–14 skills separated by " • ".
Use UK/ATS wording.

Candidate CV:
"""${safeCV}"""

Job description:
"""${safeJD}"""
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.25,
  });

  return resp.choices[0].message.content.trim();
}

/* ============= MAIN HANDLER ============= */
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
    const contentType = req.headers["content-type"] || "";
    let cvText = "";
    let jdText = "";
    let email = "";

    /* --------- MULTIPART (UPLOAD) --------- */
    if (contentType.includes("multipart/form-data")) {
      const form = formidable({ multiples: false, keepExtensions: true });

      const { fields, files } = await new Promise((resolve, reject) => {
        form.parse(req, (err, fields, files) => {
          if (err) reject(err);
          else resolve({ fields, files });
        });
      });

      // handle different field names + array shape
      const fileField = files.cvFile || files.cv || files.file;
      const file = Array.isArray(fileField) ? fileField[0] : fileField;

      if (!file || !file.filepath) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      cvText = await readUploadedFile(file);
      jdText = S(fields.jd || fields.jobDescription);
      email = S(fields.email);
    }

    /* --------- JSON (PASTE) --------- */
    else {
      const body =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      cvText = S(body.cvText || body.oldCvText || body.pastedCv);
      jdText = S(body.jd || body.jobDescription);
      email = S(body.email);
    }

    if (!cvText) {
      return res.status(400).json({ error: "No CV text found" });
    }

    // reduce size (avoid OpenAI “context length” error)
    cvText = cvText.slice(0, MAX_CV_CHARS);
    jdText = jdText.slice(0, MAX_JD_CHARS);

    // 1) parse
    const parsed = parsePastedCvImproved(cvText);

    // 2) AI
    const [summary, expAligned, skillsLine] = await Promise.all([
      aiSummary({ summaryText: parsed.summaryText || cvText.slice(0, 500), jdText }),
      aiExperience({ expText: parsed.expText || cvText, jdText }),
      aiSkills({ cvText, jdText }),
    ]);

    const educationBlock =
      parsed.eduText || "Education details available on request.";

    // 3) build docx (your structure)
    const children = [];

    // name & contact at center
    children.push(centerHeading(parsed.fullName || "Candidate"));
    if (parsed.contactLine) {
      children.push(centerLine(parsed.contactLine));
    }

    // profile summary
    children.push(label("PROFILE SUMMARY"));
    children.push(para(summary));

    // key skills
    children.push(label("KEY SKILLS"));
    children.push(para(skillsLine));

    // experience
    children.push(label("PROFESSIONAL EXPERIENCE"));
    expAligned
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((line) => {
        if (line.startsWith("•") || line.startsWith("-")) {
          children.push(bullet(line.replace(/^[-•]\s?/, "")));
        } else {
          children.push(para(line));
        }
      });

    // education
    children.push(label("EDUCATION"));
    educationBlock
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((line) => children.push(para(line)));

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

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent("HireEdge_CV.docx")}"`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    return res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error("❌ generate-resume error:", err);
    return res.status(500).json({
      error: "AI resume generation failed",
      details: String(err),
    });
  }
}
