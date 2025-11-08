// pages/api/generate-resume.js
// HireEdge – CV generator (paste OR upload) that PRESERVES user content,
// aligns to JD, and outputs a UK-style modern structure.

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

// lazy imports for heavy parsers (we only load if user uploads)
let mammoth;   // for .docx
let pdfParse;  // for .pdf

// CORS — set to your Framer site
const ALLOWED_ORIGIN = "https://hireedge.co.uk";

// tiny helper
const S = (v) => (v ?? "").toString().trim();

// disable Next.js default body parser because we accept multipart
export const config = {
  api: {
    bodyParser: false,
  },
};

// ============ OPENAI CLIENT ============
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ============ DOCX HELPERS ============
const centerHeading = (txt, size = 32, bold = true) =>
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
    children: [new TextRun({ text: txt, bold, size })],
  });

const label = (txt) =>
  new Paragraph({
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text: txt, bold: true })],
  });

const para = (txt) => new Paragraph({ children: [new TextRun(txt)] });
const bullet = (txt) => new Paragraph({ text: txt, bullet: { level: 0 } });

// ============ SIMPLE CV PARSER FOR PASTED TEXT ============
function parsePastedCv(raw = "") {
  const txt = raw.replace(/\r/g, "\n");
  const lines = txt.split("\n").map((l) => l.trim());

  // try to infer a few things from pasted text
  const fullName = lines[0] || "Candidate";
  const contactLine = lines[1] || "";

  const summaryMatch = txt.match(/summary\s*\n([\s\S]*?)(experience|education|skills)/i);
  const summaryText = summaryMatch ? summaryMatch[1].trim() : "";

  const expMatch = txt.match(/experience\s*\n([\s\S]*?)(education|skills|profile|certifications|$)/i);
  const expText = expMatch ? expMatch[1].trim() : "";

  const eduMatch = txt.match(/education\s*\n([\s\S]*?)$/i);
  const eduText = eduMatch ? eduMatch[1].trim() : "";

  return {
    fullName,
    contactLine,
    summaryText,
    expText,
    eduText,
  };
}

// ============ UPLOAD PARSERS ============

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

  // fallback: just read as text
  return fs.readFileSync(file.filepath, "utf8");
}

// ============ AI PROMPTS ============

async function rewriteSummary({ currentSummary, jd, targetTitle }) {
  const client = getOpenAIClient();
  if (!client) {
    return (
      currentSummary ||
      `Analytical and motivated professional targeting ${targetTitle || "the role"}.`
    );
  }

  const prompt = `
You are a UK CV writer.

Rewrite the following candidate summary so that:
- it stays TRUE to the candidate
- it reflects the job description below
- it is 3–4 sentences
- it is ATS-friendly
- tone: professional, confident, not flowery

Candidate summary:
"""${currentSummary}"""

Job description:
"""${jd}"""

Return ONLY the rewritten summary.
  `.trim();

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.35,
  });

  return resp.choices[0].message.content.trim();
}

async function alignExperience({ expText, jd }) {
  const client = getOpenAIClient();
  if (!client) {
    // no AI – just keep original lines
    return expText
      .split("\n")
      .filter(Boolean)
      .map((l) => l.replace(/^[-•]\s?/, "").trim())
      .slice(0, 12);
  }

  const prompt = `
You will receive a candidate's EXPERIENCE SECTION exactly as they pasted it.

Your task:
1. Keep every job they actually had (titles, companies, dates).
2. For each job, rewrite or add 3–5 bullet points.
3. Bullets must reflect the candidate's pasted experience BUT be aligned to the job description below.
4. Do NOT invent fake employers, fake dates, or fake achievements.
5. Output in this format:

Job Title | Company – Location
MM/YYYY – MM/YYYY
• bullet
• bullet
• bullet

Candidate experience:
"""${expText}"""

Job description:
"""${jd}"""

Return ONLY the structured experience in the exact format above.
  `.trim();

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4,
  });

  return resp.choices[0].message.content.trim();
}

async function buildSkills({ cvText, jd }) {
  const client = getOpenAIClient();
  if (!client) {
    return "Stakeholder Management • Customer Service • Sales • Reporting";
  }

  const prompt = `
From the candidate CV and the job description, produce a single-row list of 10–14 skills separated by " • ".
Rules:
- keep skills that the candidate actually has
- add JD skills ONLY if they are transferable
- UK/ATS style skill names
- no sentences, just skills

Candidate CV:
"""${cvText}"""

Job description:
"""${jd}"""
  `.trim();

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
  });

  return resp.choices[0].message.content.trim();
}

// ============ MAIN HANDLER ============

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "HireEdge API alive" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const contentType = req.headers["content-type"] || "";
    let cvText = "";
    let jdText = "";
    let userEmail = "";

    // ===== multipart (upload) =====
    if (contentType.includes("multipart/form-data")) {
      const form = formidable({ multiples: false, keepExtensions: true });
      const { fields, files } = await new Promise((resolve, reject) => {
        form.parse(req, (err, fields, files) => {
          if (err) reject(err);
          else resolve({ fields, files });
        });
      });

      const file =
        files.cvFile || files.cv || files.file || files.upload || null;

      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      cvText = await readUploadedFile(file);
      jdText = S(fields.jobDescription || fields.jd);
      userEmail = S(fields.email || fields.userEmail);
    } else {
      // ===== JSON (Framer fetch) =====
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const body = rawBody ? JSON.parse(rawBody) : {};

      cvText = S(body.cvText || body.oldCvText || body.pastedCv);
      jdText = S(body.jobDescription || body.jd);
      userEmail = S(body.email);
    }

    if (!cvText) {
      return res.status(400).json({ error: "No CV text found" });
    }

    // 1. parse pasted CV
    const parsed = parsePastedCv(cvText);

    // 2. AI: better summary
    const aiSummary = await rewriteSummary({
      currentSummary: parsed.summaryText || cvText.slice(0, 400),
      jd: jdText,
      targetTitle: "",
    });

    // 3. AI: experience aligned
    const alignedExperience = await alignExperience({
      expText: parsed.expText || cvText,
      jd: jdText,
    });

    // 4. AI: skills line
    const skillsLine = await buildSkills({ cvText, jd: jdText });

    // 5. education – keep user’s one if we parsed, else simple
    const eduBlock =
      parsed.eduText ||
      "MSc Data Science – University of Roehampton, London (2024)\nMBA – ICFAI Business School, Bangalore (2019)\nBE Mechanical Engineering – Nandha College of Technology, Erode (2017)";

    // ============ BUILD DOCX ============
    const children = [];

    // Name
    children.push(
      centerHeading(parsed.fullName || "Candidate", 40, true)
    );

    // contact line
    if (parsed.contactLine) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [new TextRun(parsed.contactLine)],
        })
      );
    }

    // PROFILE SUMMARY
    children.push(label("PROFILE SUMMARY"));
    children.push(para(aiSummary));

    // KEY SKILLS
    children.push(label("KEY SKILLS"));
    children.push(para(skillsLine));

    // EXPERIENCE
    children.push(label("PROFESSIONAL EXPERIENCE"));
    alignedExperience
      .split("\n")
      .filter(Boolean)
      .forEach((line) => {
        if (line.startsWith("•")) {
          children.push(bullet(line.replace(/^•\s?/, "")));
        } else {
          children.push(para(line));
        }
      });

    // EDUCATION
    children.push(label("EDUCATION"));
    eduBlock
      .split("\n")
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
    const filename = "HireEdge_CV.docx";

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(filename)}"`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error("generate-resume error:", err);
    res.status(500).json({
      error: "AI resume generation failed",
      details: String(err),
    });
  }
}
