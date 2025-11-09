// pages/api/generate-resume.js
// HireEdge – CV generator (paste or upload) with fixed structure

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

// your Framer domain
const ALLOWED_ORIGIN = "https://hireedge.co.uk";

// small helpers
const S = (v) => (v ?? "").toString().trim();
const MAX_AI_CHARS = 9000; // to avoid token overflow

// Next.js: disable default body parsing, we handle multipart ourselves
export const config = {
  api: {
    bodyParser: false,
  },
};

// ---------- OpenAI client ----------
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ---------- text cleaners ----------
function cleanCvText(raw = "") {
  if (!raw) return "";
  const lines = raw
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim());

  const cleaned = lines.filter((l) => {
    // kill lines that are just page numbers like "1", "2", "3"
    if (/^page\s+\d+/i.test(l)) return false;
    if (/^\d{1,3}$/.test(l)) return false;
    return true;
  });

  return cleaned.join("\n").trim();
}

// ---------- very light parser for pasted CV ----------
function parsePastedCv(raw = "") {
  const txt = raw.replace(/\r/g, "\n");
  const lines = txt.split("\n").map((l) => l.trim()).filter(Boolean);

  const fullName = lines[0] || "Candidate";
  // try to guess a contact line: next 1–2 lines that have @ or digits
  let contactLine = "";
  for (let i = 1; i < Math.min(lines.length, 5); i++) {
    if (/@/.test(lines[i]) || /\d/.test(lines[i])) {
      contactLine = lines[i];
      break;
    }
  }

  const summaryMatch = txt.match(/summary\s*\n([\s\S]*?)(experience|professional experience|work history|employment|education|skills)/i);
  const summaryText = summaryMatch ? summaryMatch[1].trim() : "";

  const expMatch = txt.match(/(experience|professional experience|work history|employment)\s*\n([\s\S]*?)(education|skills|certifications|$)/i);
  const expText = expMatch ? expMatch[2].trim() : "";

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

// ---------- upload readers ----------
async function readUploadedFile(file) {
  // file can be undefined if field name mismatched
  if (!file) return "";

  const ext = path.extname(file.originalFilename || "").toLowerCase();

  // .docx
  if (ext === ".docx") {
    if (!mammoth) {
      mammoth = (await import("mammoth")).default;
    }
    const resp = await mammoth.extractRawText({ path: file.filepath });
    return resp.value || "";
  }

  // .pdf
  if (ext === ".pdf") {
    if (!pdfParse) {
      pdfParse = (await import("pdf-parse")).default;
    }
    const buffer = fs.readFileSync(file.filepath);
    const data = await pdfParse(buffer);
    return data.text || "";
  }

  // fallback: read as text
  return fs.readFileSync(file.filepath, "utf8");
}

// ---------- AI helpers ----------
async function aiSummary({ currentSummary, jd }) {
  const client = getOpenAIClient();
  if (!client) {
    return (
      currentSummary ||
      "Customer-focused professional with experience across sales, client support, and operations, now tailoring profile to the provided role."
    );
  }

  const prompt = `
You are a UK CV writer.

Rewrite the following summary so that it:
- stays true to the candidate
- sounds suitable for the job description
- is 3–4 sentences
- is ATS-friendly
- no fake achievements

Candidate summary:
"""${currentSummary}"""

Job description:
"""${jd}"""

Return ONLY the final summary.
  `.trim();

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.35,
  });

  return resp.choices[0].message.content.trim();
}

async function aiSkills({ cvText, jd }) {
  const client = getOpenAIClient();
  if (!client) {
    return "Customer Service • Relationship Management • Sales Support • Communication • Stakeholder Engagement • Time Management";
  }

  const prompt = `
From the candidate CV and the job description, produce ONE line of 10–14 skills separated by " • ".
Include candidate skills first, then add relevant JD skills.
No sentences, no numbering.

CV:
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

async function aiExperience({ expText, jd }) {
  const client = getOpenAIClient();
  if (!client) {
    return expText; // fallback
  }

  const prompt = `
You will receive the candidate's EXPERIENCE section exactly as pasted.

Rewrite it in UK CV style like:

Job Title | Company – City/Country
MM/YYYY – MM/YYYY
• bullet
• bullet

Rules:
- Keep the same jobs, titles, and employers (no inventions).
- Make bullets sound more impact/achievement oriented.
- Make them relevant to this job description:
"""${jd}"""
- 4–6 bullets per recent role, 2–3 for older ones.
- Don't add page numbers or headers.
- Return ONLY the rewritten experience.
Original experience:
"""${expText}"""
  `.trim();

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.45,
  });

  return resp.choices[0].message.content.trim();
}

// ---------- main handler ----------
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "HireEdge resume API alive ✅" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const contentType = req.headers["content-type"] || "";
    let cvText = "";
    let jdText = "";
    let userEmail = "";

    // ---------- 1. multipart (upload) ----------
    if (contentType.includes("multipart/form-data")) {
      const form = formidable({ multiples: false, keepExtensions: true });

      const { fields, files } = await new Promise((resolve, reject) => {
        form.parse(req, (err, flds, fls) => {
          if (err) reject(err);
          else resolve({ fields: flds, files: fls });
        });
      });

      // try all common field names
      const uploadedFile =
        files.cvFile || files.cv || files.file || files.upload;

      const rawText = await readUploadedFile(uploadedFile);
      cvText = cleanCvText(rawText);

      jdText = S(fields.jobDescription || fields.jd || "");
      userEmail = S(fields.email || fields.userEmail || "");
    } else {
      // ---------- 2. JSON (paste) ----------
      const body =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

      const rawCv =
        body.cvText || body.oldCvText || body.pastedCv || body.text || "";
      cvText = cleanCvText(S(rawCv));

      jdText = S(body.jobDescription || body.jd || "");
      userEmail = S(body.email || "");
    }

    if (!cvText) {
      return res.status(400).json({ error: "No CV text found" });
    }

    // truncate for AI
    const cvForAI = cvText.slice(0, MAX_AI_CHARS);
    const jdForAI = jdText.slice(0, 3500);

    // parse basic fields
    const parsed = parsePastedCv(cvText);

    // build AI pieces
    const [summaryAI, skillsAI, expAI] = await Promise.all([
      aiSummary({
        currentSummary:
          parsed.summaryText || cvForAI.slice(0, 600) || "Experienced professional.",
        jd: jdForAI,
      }),
      aiSkills({ cvText: cvForAI, jd: jdForAI }),
      aiExperience({
        expText: parsed.expText || cvForAI,
        jd: jdForAI,
      }),
    ]);

    const eduBlock =
      parsed.eduText ||
      "Education details available on request.";

    // ---------- build DOCX ----------
    const children = [];

    // name
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 40 },
        children: [
          new TextRun({
            text: parsed.fullName || "Candidate",
            bold: true,
            size: 40,
          }),
        ],
      })
    );

    // contact line
    const contactBits = [];
    if (parsed.contactLine) contactBits.push(parsed.contactLine);
    if (userEmail && !parsed.contactLine?.includes(userEmail)) {
      contactBits.push(userEmail);
    }
    if (contactBits.length) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [new TextRun(contactBits.join(" | "))],
        })
      );
    }

    // PROFILE SUMMARY
    children.push(
      new Paragraph({
        spacing: { before: 120, after: 60 },
        children: [new TextRun({ text: "PROFILE SUMMARY", bold: true })],
      })
    );
    children.push(new Paragraph(summaryAI));

    // KEY SKILLS
    children.push(
      new Paragraph({
        spacing: { before: 200, after: 60 },
        children: [new TextRun({ text: "KEY SKILLS", bold: true })],
      })
    );
    children.push(new Paragraph(skillsAI));

    // EXPERIENCE
    children.push(
      new Paragraph({
        spacing: { before: 200, after: 60 },
        children: [new TextRun({ text: "PROFESSIONAL EXPERIENCE", bold: true })],
      })
    );

    // split AI experience into lines and render intelligently
    expAI
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((line) => {
        if (line.startsWith("•")) {
          children.push(
            new Paragraph({
              text: line.replace(/^•\s?/, ""),
              bullet: { level: 0 },
            })
          );
        } else {
          children.push(new Paragraph(line));
        }
      });

    // EDUCATION
    children.push(
      new Paragraph({
        spacing: { before: 200, after: 60 },
        children: [new TextRun({ text: "EDUCATION", bold: true })],
      })
    );
    eduBlock
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((line) => {
        children.push(new Paragraph(line));
      });

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
    console.error("❌ AI resume generation failed:", err);
    return res.status(500).json({
      error: "AI resume generation failed",
      details: String(err),
    });
  }
}
