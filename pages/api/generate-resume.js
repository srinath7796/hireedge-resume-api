// pages/api/generate-resume.js
// HireEdge – CV generator (paste OR upload) that keeps user content,
// aligns to JD, and outputs a UK-style structure.

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

let mammoth;   // lazy for .docx
let pdfParse;  // lazy for .pdf

// your Framer domain
const ALLOWED_ORIGIN = "https://hireedge.co.uk";

// helper
const S = (v) => (v ?? "").toString().trim();

// tell Next we’ll parse the body ourselves (because of multipart)
export const config = {
  api: {
    bodyParser: false,
  },
};

// ============ OPENAI =============
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ============ DOCX BUILD HELPERS ============
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

// ============ PARSE PASTED CV (simple) ============
function parsePastedCv(raw = "") {
  const txt = raw.replace(/\r/g, "\n");
  const lines = txt.split("\n").map((l) => l.trim()).filter(Boolean);

  const fullName = lines[0] || "Candidate";
  const contactLine = lines[1] || "";

  const summaryMatch = txt.match(/summary\s*\n([\s\S]*?)(experience|education|skills)/i);
  const expMatch = txt.match(/experience\s*\n([\s\S]*?)(education|skills|profile|certifications|$)/i);
  const eduMatch = txt.match(/education\s*\n([\s\S]*?)$/i);

  const summaryText = summaryMatch ? summaryMatch[1].trim() : "";
  const expText = expMatch ? expMatch[1].trim() : "";
  const eduText = eduMatch ? eduMatch[1].trim() : "";

  return {
    fullName,
    contactLine,
    summaryText,
    expText,
    eduText,
  };
}

// ============ READ UPLOADED FILE (robust) ============
async function readUploadedFile(file) {
  // formidable can return either .filepath (new) or .path (old)
  const filepath = file.filepath || file.path;
  if (!filepath) {
    throw new Error("Uploaded file has no filepath/path");
  }

  const ext = path.extname(file.originalFilename || "").toLowerCase();

  if (ext === ".docx") {
    if (!mammoth) {
      mammoth = (await import("mammoth")).default;
    }
    const result = await mammoth.extractRawText({ path: filepath });
    return result.value || "";
  }

  if (ext === ".pdf") {
    if (!pdfParse) {
      pdfParse = (await import("pdf-parse")).default;
    }
    const buffer = fs.readFileSync(filepath);
    const data = await pdfParse(buffer);
    return data.text || "";
  }

  // fallback: try text
  return fs.readFileSync(filepath, "utf8");
}

// ============ AI HELPERS ============

async function rewriteSummary({ currentSummary, jd, targetTitle }) {
  const client = getOpenAIClient();
  if (!client) {
    return (
      currentSummary ||
      `Motivated professional targeting ${targetTitle || "the role"} and aligned to the job description.`
    );
  }

  const prompt = `
You are a UK CV writer.

Rewrite the following candidate summary so that:
- it stays true to what the candidate actually said
- it aligns to the job description
- 3–4 sentences
- ATS-friendly
- UK tone

Candidate summary:
"""${currentSummary}"""

Job description:
"""${jd}"""

Return ONLY the rewritten summary.
`;

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
    return expText;
  }

  const prompt = `
You will receive a candidate's EXPERIENCE SECTION.

Rewrite it in UK CV style, keep the real jobs, but make the bullets speak to this job:

Job description:
"""${jd}"""

Candidate experience:
"""${expText}"""

Format output like:

Job Title | Company – Location
MM/YYYY – MM/YYYY
• bullet
• bullet

Return ONLY the experience.
`;

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
    return "Sales • Stakeholder Management • Customer Relationships • Reporting";
  }

  const prompt = `
From the candidate CV and the JD, output 10–14 skills, one line, separated by " • ".
Keep realistic/transferable skills only.

CV:
"""${cvText}"""

JD:
"""${jd}"""
`;

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
    return res.status(200).json({ ok: true, message: "HireEdge API alive ✅" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const contentType = req.headers["content-type"] || "";
    let cvText = "";
    let jdText = "";
    let userEmail = "";

    if (contentType.includes("multipart/form-data")) {
      // ========== UPLOAD FLOW ==========
      const form = formidable({ multiples: false, keepExtensions: true });
      const { fields, files } = await new Promise((resolve, reject) => {
        form.parse(req, (err, fields, files) => {
          if (err) reject(err);
          else resolve({ fields, files });
        });
      });

      // try every possible key
      let file =
        files.cv ||
        files.file ||
        files.cvFile ||
        files.upload ||
        Object.values(files)[0];

      // some versions give array
      if (Array.isArray(file)) {
        file = file[0];
      }

      if (!file) {
        return res.status(400).json({ error: "No file uploaded (server did not receive a file field)" });
      }

      cvText = await readUploadedFile(file);
      jdText = S(fields.jobDescription || fields.jd);
      userEmail = S(fields.email);
    } else {
      // ========== PASTE FLOW ==========
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      cvText = S(body.cvText || body.oldCvText || body.pastedCv);
      jdText = S(body.jobDescription || body.jd);
      userEmail = S(body.email);
    }

    if (!cvText) {
      return res.status(400).json({ error: "No CV text found" });
    }

    // clamp to avoid token overflow
    if (cvText.length > 15000) cvText = cvText.slice(0, 15000);
    if (jdText.length > 4000) jdText = jdText.slice(0, 4000);

    // 1. parse
    const parsed = parsePastedCv(cvText);

    // 2. AI parts
    const aiSummary = await rewriteSummary({
      currentSummary: parsed.summaryText || cvText.slice(0, 600),
      jd: jdText,
      targetTitle: "",
    });

    const alignedExp = await alignExperience({
      expText: parsed.expText || cvText,
      jd: jdText,
    });

    const skillsLine = await buildSkills({ cvText, jd: jdText });

    const eduBlock =
      parsed.eduText ||
      "MSc Data Science – University of Roehampton, London (2024)\nMBA – ICFAI Business School, Bangalore (2019)\nBE Mechanical Engineering – Nandha College of Technology, Erode (2017)";

    // 3. build docx
    const children = [];

    // name
    children.push(centerHeading(parsed.fullName || "Candidate", 40, true));

    // contact
    if (parsed.contactLine) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [new TextRun(parsed.contactLine)],
        })
      );
    }

    // summary
    children.push(label("PROFILE SUMMARY"));
    children.push(para(aiSummary));

    // skills
    children.push(label("KEY SKILLS"));
    children.push(para(skillsLine));

    // experience
    children.push(label("PROFESSIONAL EXPERIENCE"));
    alignedExp
      .split("\n")
      .filter(Boolean)
      .forEach((line) => {
        if (line.startsWith("•")) {
          children.push(bullet(line.replace(/^•\s?/, "")));
        } else {
          children.push(para(line));
        }
      });

    // education
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

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="HireEdge_CV.docx"'
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    return res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error("generate-resume error:", err);
    return res.status(500).json({
      error: "AI resume generation failed",
      details: String(err),
    });
  }
}
