// pages/api/generate-resume.js
// HireEdge – finalised version
// - accepts JSON (paste) AND multipart/form-data (upload)
// - extracts real text from .docx / .pdf on the server
// - fixes "name became 1" by skipping page numbers
// - always outputs your structure

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

// we will lazy-load these only when a file is uploaded
let mammoth;   // for .docx
let pdfParse;  // for .pdf

// your Framer domain
const ALLOWED_ORIGIN = "https://hireedge.co.uk";

// tiny helper
const S = (v) => (v ?? "").toString().trim();

// Next.js – allow multipart
export const config = {
  api: {
    bodyParser: false,
  },
};

/* -----------------------------------------------------------
   OpenAI client (works even if key missing)
----------------------------------------------------------- */
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/* -----------------------------------------------------------
   Very small docx helpers
----------------------------------------------------------- */
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

/* -----------------------------------------------------------
   1. PARSE PASTED CV (fixes "1" problem)
----------------------------------------------------------- */
function parsePastedCvImproved(raw = "") {
  const txt = raw.replace(/\r/g, "\n");
  const lines = txt
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // find first line that actually looks like a name
  // skip lines that are just numbers, "page 1", "1", "2", etc.
  let fullName = "Candidate";
  for (const line of lines) {
    const lower = line.toLowerCase();
    const onlyDigits = /^[0-9. ]+$/.test(line);
    const isPage = lower.startsWith("page ");
    if (onlyDigits || isPage) {
      continue;
    }
    // likely a name
    fullName = line;
    break;
  }

  // contact line – next non-empty, non-number line
  let contactLine = "";
  const nameIndex = lines.indexOf(fullName);
  for (let i = nameIndex + 1; i < lines.length; i++) {
    const l = lines[i];
    const onlyDigits = /^[0-9. ]+$/.test(l);
    if (!l || onlyDigits) continue;
    contactLine = l;
    break;
  }

  // split into rough blocks
  const summaryMatch = txt.match(/summary\s*\n([\s\S]*?)(experience|work experience|employment|education|skills|$)/i);
  const summaryText = summaryMatch ? summaryMatch[1].trim() : "";

  const expMatch = txt.match(/(experience|work experience|employment)\s*\n([\s\S]*?)(education|skills|certifications|$)/i);
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

/* -----------------------------------------------------------
   2. READ UPLOADED FILE (real .docx / .pdf)
----------------------------------------------------------- */
async function readUploadedFile(file) {
  const ext = path.extname(file.originalFilename || "").toLowerCase();

  // .docx
  if (ext === ".docx") {
    if (!mammoth) {
      mammoth = (await import("mammoth")).default;
    }
    const result = await mammoth.extractRawText({ path: file.filepath });
    return result.value || "";
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

  // fallback – try read as text
  return fs.readFileSync(file.filepath, "utf8");
}

/* -----------------------------------------------------------
   3. AI HELPERS (all capped for token size)
----------------------------------------------------------- */
const MAX_CV_CHARS = 6000;
const MAX_JD_CHARS = 4000;

async function aiSummary({ summaryText, jdText, targetTitle }) {
  const client = getOpenAIClient();
  const safeSummary = (summaryText || "").slice(0, 1200);
  const safeJD = (jdText || "").slice(0, 1200);

  if (!client) {
    return (
      safeSummary ||
      `Motivated professional targeting ${targetTitle || "the role"}, with strong stakeholder and customer-facing experience.`
    );
  }

  const prompt = `
You are a UK CV writer.

Rewrite the candidate's profile into 3–4 sentences, ATS-friendly, and aligned to the job description.
Keep it true to the candidate. Do NOT invent companies or fake achievements.

Candidate summary:
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

  if (!client) {
    // fallback – just return user's experience
    return safeExp;
  }

  const prompt = `
You will receive the candidate's pasted EXPERIENCE section.

Rewrite it to:
- keep the same real jobs (do NOT invent new employers)
- make bullets result / ownership / relationship focused
- align wording to this job description
- UK CV tone

Candidate EXPERIENCE:
"""${safeExp}"""

Job description:
"""${safeJD}"""

Return only the CV experience section in plain text. Keep job titles and companies on their own lines.
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
    return "Sales • Relationship Building • Customer Service • Stakeholder Management • Reporting • Time Management";
  }

  const prompt = `
From the candidate CV and the job description, produce 10–14 skills separated by " • ".
Use UK wording. Include JD skills only if relevant.

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

/* -----------------------------------------------------------
   MAIN HANDLER
----------------------------------------------------------- */
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "HireEdge API running ✅" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const contentType = req.headers["content-type"] || "";
    let cvText = "";
    let jdText = "";
    let userEmail = "";

    // ------------- A) MULTIPART (upload) -------------
    if (contentType.includes("multipart/form-data")) {
      const form = formidable({ multiples: false, keepExtensions: true });

      const { fields, files } = await new Promise((resolve, reject) => {
        form.parse(req, (err, fields, files) => {
          if (err) reject(err);
          else resolve({ fields, files });
        });
      });

      // in our front-end we send the file as "cvFile"
      const file = files.cvFile || files.cv || files.file;

      if (file) {
        cvText = await readUploadedFile(file);
      }

      jdText = S(fields.jd || fields.jobDescription);
      userEmail = S(fields.email);

    // ------------- B) JSON (paste) -------------
    } else {
      const body =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      cvText = S(body.cvText || body.oldCvText || body.pastedCv);
      jdText = S(body.jobDescription || body.jd);
      userEmail = S(body.email);
    }

    // final guard
    if (!cvText) {
      return res.status(400).json({ error: "No CV text found" });
    }

    // cap lengths to avoid 400 tokens errors
    cvText = cvText.slice(0, MAX_CV_CHARS);
    jdText = jdText.slice(0, MAX_JD_CHARS);

    // step 1: parse
    const parsed = parsePastedCvImproved(cvText);

    // step 2: AI bits
    const [summary, expAligned, skillsLine] = await Promise.all([
      aiSummary({
        summaryText: parsed.summaryText || cvText.slice(0, 500),
        jdText,
        targetTitle: "",
      }),
      aiExperience({
        expText: parsed.expText || cvText,
        jdText,
      }),
      aiSkills({
        cvText,
        jdText,
      }),
    ]);

    // step 3: education (keep user if we have it)
    const educationBlock =
      parsed.eduText ||
      "Education details available on request.";

    /* -------------------------------------------------
       BUILD DOCX in the exact structure you want
    ------------------------------------------------- */
    const children = [];

    // Name centered
    children.push(centerHeading(parsed.fullName || "Candidate"));

    // Contact centered
    if (parsed.contactLine) {
      children.push(centerLine(parsed.contactLine));
    }

    // PROFILE SUMMARY
    children.push(label("PROFILE SUMMARY"));
    children.push(para(summary));

    // KEY SKILLS
    children.push(label("KEY SKILLS"));
    children.push(para(skillsLine));

    // PROFESSIONAL EXPERIENCE
    children.push(label("PROFESSIONAL EXPERIENCE"));
    // split AI experience into lines, bullets for lines starting with •
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

    // EDUCATION
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
