// pages/api/generate-resume.js
// HireEdge – CV generator (paste + upload) with robust file handling

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

let mammoth;   // for .docx
let pdfParse;  // for .pdf

// your framer domain
const ALLOWED_ORIGIN = "https://hireedge.co.uk";

// small helper
const S = (v) => (v ?? "").toString().trim();

// Next.js: allow multipart
export const config = {
  api: {
    bodyParser: false,
  },
};

// ---------- OpenAI ----------
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ---------- docx helpers ----------
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

// ---------- parse pasted CV quickly ----------
function parsePastedCv(raw = "") {
  const txt = raw.replace(/\r/g, "\n").trim();
  const lines = txt.split("\n").map((l) => l.trim()).filter(Boolean);

  // first non-empty line is usually the name
  const fullName = lines[0] || "Candidate";

  // second line is often contacts
  const contactLine = lines[1] || "";

  // sections
  const summaryMatch = txt.match(/summary\s*\n([\s\S]*?)(experience|employment|work history|education|skills|$)/i);
  const summaryText = summaryMatch ? summaryMatch[1].trim() : "";

  const expMatch = txt.match(/(experience|employment|work history)\s*\n([\s\S]*?)(education|skills|certifications|$)/i);
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

// ---------- upload parsers (robust) ----------
async function readUploadedFile(anyFile) {
  // 1) Vercel/Formidable sometimes returns array
  const file = Array.isArray(anyFile) ? anyFile[0] : anyFile;
  if (!file) throw new Error("No file object received from formidable");

  // 2) try to discover actual path
  const realPath =
    file.filepath ||
    file.path || // older
    (file._writeStream && file._writeStream.path) ||
    (file.file && file.file.filepath);

  if (!realPath) {
    // we cannot read it from disk, bail out clearly
    throw new Error("Uploaded file has no filepath on server");
  }

  const ext = path.extname(file.originalFilename || realPath || "").toLowerCase();

  if (ext === ".docx") {
    if (!mammoth) {
      mammoth = (await import("mammoth")).default;
    }
    const result = await mammoth.extractRawText({ path: realPath });
    return result.value || "";
  }

  if (ext === ".pdf") {
    if (!pdfParse) {
      pdfParse = (await import("pdf-parse")).default;
    }
    const buffer = fs.readFileSync(realPath);
    const data = await pdfParse(buffer);
    return data.text || "";
  }

  // fallback: try to read as text
  return fs.readFileSync(realPath, "utf8");
}

// ---------- AI helpers ----------
async function rewriteSummary({ currentSummary, jd, targetTitle }) {
  const client = getOpenAIClient();
  const base =
    currentSummary ||
    `Motivated professional targeting ${targetTitle || "the role"}.`;

  if (!client) return base;

  // trim so we don't exceed context
  const trimmedCv = currentSummary.slice(0, 2000);
  const trimmedJd = jd.slice(0, 2000);

  const prompt = `
You are a UK CV writer.

Rewrite the candidate summary so it stays true to them but aligns to this job.
3–4 sentences. ATS-friendly. No waffle.

Candidate summary:
"""${trimmedCv}"""

Job description:
"""${trimmedJd}"""

Return ONLY the summary.
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

  const trimmedExp = expText.slice(0, 3500);
  const trimmedJd = jd.slice(0, 1500);

  if (!client) {
    return trimmedExp || "Experience details not available.";
  }

  const prompt = `
Take the candidate experience below and rewrite it into UK-CV style.
- KEEP the same jobs (don't invent companies / dates)
- 3–5 bullets per job
- bias bullets toward this job description.

Candidate experience:
"""${trimmedExp}"""

Job description:
"""${trimmedJd}"""

Return only the formatted experience.
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
    return "Customer Service • Stakeholder Management • Time Management • Problem Solving";
  }

  const trimmedCv = cvText.slice(0, 2000);
  const trimmedJd = jd.slice(0, 1500);

  const prompt = `
Make one line of 10–14 skills separated by " • ".
Use only skills that appear or are clearly transferable.

CV:
"""${trimmedCv}"""

JD:
"""${trimmedJd}"""
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
  });

  return resp.choices[0].message.content.trim();
}

// ---------- main handler ----------
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
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
    let mode = "paste";

    if (contentType.includes("multipart/form-data")) {
      // ---------- UPLOAD ----------
      mode = "upload";
      const form = formidable({ multiples: false, keepExtensions: true });

      const { fields, files } = await new Promise((resolve, reject) => {
        form.parse(req, (err, fields, files) => {
          if (err) reject(err);
          else resolve({ fields, files });
        });
      });

      // your frontend sends "cvFile"
      const uploadedFile =
        files.cvFile ||
        files.cv ||
        files.file ||
        null;

      if (!uploadedFile) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      cvText = await readUploadedFile(uploadedFile);
      jdText = S(fields.jd || fields.jobDescription);
      userEmail = S(fields.email);

    } else {
      // ---------- PASTE ----------
      const body =
        typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

      cvText = S(body.cvText || body.oldCvText || body.pastedCv);
      jdText = S(body.jd || body.jobDescription);
      userEmail = S(body.email);
      mode = S(body.mode || "paste");
    }

    if (!cvText) {
      return res.status(400).json({ error: "No CV text found" });
    }

    // parse pasted cv
    const parsed = parsePastedCv(cvText);

    // AI parts
    const aiSummary = await rewriteSummary({
      currentSummary: parsed.summaryText || cvText.slice(0, 500),
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
      "Education details as provided by the candidate.";

    // ---------- build DOCX ----------
    const children = [];

    // name at centre
    children.push(centerHeading(parsed.fullName || "Candidate", 36, true));

    // contact line centre
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
    alignedExp
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .forEach((line) => {
        if (line.startsWith("•") || line.startsWith("-")) {
          children.push(bullet(line.replace(/^[-•]\s?/, "").trim()));
        } else {
          children.push(para(line));
        }
      });

    // EDUCATION
    children.push(label("EDUCATION"));
    eduBlock
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .forEach((line) => children.push(para(line)));

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
    const filename = "HireEdge_CV.docx";

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
    console.error("generate-resume error:", err);
    return res.status(500).json({
      error: "AI resume generation failed",
      details: String(err),
    });
  }
}
