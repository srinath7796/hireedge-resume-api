// pages/api/generate-resume.js
// HireEdge – AI CV generator (paste or upload)
// - name centered
// - contact line under it
// - cleans random "1/2/3" lines
// - works with multipart + JSON
// - aligns to job description

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

const ALLOWED_ORIGIN = "https://hireedge.co.uk";
const S = (v) => (v ?? "").toString().trim();

export const config = {
  api: {
    bodyParser: false, // we handle multipart + raw JSON ourselves
  },
};

// ---------- helpers ----------
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const centerHeading = (txt, size = 40) =>
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
    children: [new TextRun({ text: txt, bold: true, size })],
  });

const label = (txt) =>
  new Paragraph({
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text: txt, bold: true })],
  });

const para = (txt) => new Paragraph({ children: [new TextRun(txt)] });
const bullet = (txt) => new Paragraph({ text: txt, bullet: { level: 0 } });

// ---------- 1) clean + parse pasted CV ----------
function parsePastedCv(raw = "") {
  // 1) remove lone numbers (1,2,3) from docx/pdf extraction
  const cleaned = raw
    .replace(/\r/g, "\n")
    .replace(/^\s*\d+\s*$/gm, ""); // kill lines that are just numbers

  const lines = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // find first line that looks like a real name (starts with a letter)
  const fullName =
    lines.find((l) => /^[A-Za-z]/.test(l)) || "Candidate";

  // find a contact-like line (email/phone/linkedin/postcode)
  const contactLine =
    lines.find(
      (l) =>
        l.includes("@") ||
        /\d/.test(l) ||
        l.toLowerCase().includes("linkedin") ||
        l.toLowerCase().includes("london") ||
        l.toLowerCase().includes("uk")
    ) || "";

  // try to pull sections
  const summaryMatch = cleaned.match(/summary\s*\n([\s\S]*?)(experience|education|skills)/i);
  const expMatch = cleaned.match(/experience\s*\n([\s\S]*?)(education|skills|profile|certifications|$)/i);
  const eduMatch = cleaned.match(/education\s*\n([\s\S]*?)$/i);

  return {
    fullName,
    contactLine,
    summaryText: summaryMatch ? summaryMatch[1].trim() : "",
    expText: expMatch ? expMatch[1].trim() : "",
    eduText: eduMatch ? eduMatch[1].trim() : "",
  };
}

// ---------- 2) read uploaded file (robust) ----------
async function readUploadedFile(file) {
  // formidable can give .filepath or .path
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

  // fallback
  return fs.readFileSync(filepath, "utf8");
}

// ---------- 3) AI utils ----------
async function rewriteSummary({ currentSummary, jd, targetTitle }) {
  const client = getOpenAIClient();
  if (!client) {
    return (
      currentSummary ||
      `Motivated professional aligned to ${targetTitle || "the role"}.`
    );
  }

  const prompt = `
You are a UK CV writer.

Rewrite this summary so it:
- stays true to the candidate
- aligns to the job description
- is 3–4 sentences
- is ATS-friendly
- NO explanations, just the summary

Candidate summary:
"""${currentSummary}"""

Job description:
"""${jd}"""
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
    return expText;
  }

  const prompt = `
Rewrite the candidate's EXPERIENCE for a UK CV.

Rules:
1. Keep actual jobs, companies, and dates.
2. For each job, write 3–5 bullets.
3. Make bullets show: customer-facing work, relationship building, ownership, target/results mindset – to match the JD.
4. Output PLAIN TEXT, no code fences.

Candidate experience:
"""${expText}"""

Job description:
"""${jd}"""
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
    return "Customer Service • Relationship Building • Sales Support • Reporting • Time Management • Teamwork";
  }

  const prompt = `
From the candidate CV and this JD, output ONE line of 10–14 skills separated by " • ".
Keep it realistic and UK/ATS-friendly.

CV:
"""${cvText}"""

JD:
"""${jd}"""
`.trim();

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.25,
  });

  return resp.choices[0].message.content.trim();
}

// ---------- 4) main handler ----------
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

    // ====== A. MULTIPART (UPLOAD) ======
    if (contentType.includes("multipart/form-data")) {
      const form = formidable({ multiples: false, keepExtensions: true });
      const { fields, files } = await new Promise((resolve, reject) => {
        form.parse(req, (err, flds, fls) => {
          if (err) reject(err);
          else resolve({ fields: flds, files: fls });
        });
      });

      // try all likely keys; or first file
      let file =
        files.cv ||
        files.file ||
        files.cvFile ||
        files.upload ||
        Object.values(files)[0];

      if (Array.isArray(file)) file = file[0];

      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      cvText = await readUploadedFile(file);
      jdText = S(fields.jobDescription || fields.jd);
      userEmail = S(fields.email);
    } else {
      // ====== B. JSON (PASTE) ======
      // bodyParser is off → read raw stream
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

    // clamp huge uploads so OpenAI doesn't blow context
    if (cvText.length > 15000) cvText = cvText.slice(0, 15000);
    if (jdText.length > 4000) jdText = jdText.slice(0, 4000);

    // 1. parse user cv
    const parsed = parsePastedCv(cvText);

    // 2. AI sections
    const aiSummary = await rewriteSummary({
      currentSummary: parsed.summaryText || cvText.slice(0, 500),
      jd: jdText,
      targetTitle: "",
    });

    const alignedExperience = await alignExperience({
      expText: parsed.expText || cvText,
      jd: jdText,
    });

    const skillsLine = await buildSkills({ cvText, jd: jdText });

    // 3. education fallback
    const eduBlock =
      parsed.eduText ||
      "Education details available on request.";

    // 4. build docx
    const children = [];

    // NAME AT CENTER
    children.push(centerHeading(parsed.fullName || "Candidate", 40));

    // CONTACT LINE UNDER NAME
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

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="HireEdge_CV.docx"'
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error("generate-resume error:", err);
    res
      .status(500)
      .json({ error: "AI resume generation failed", details: String(err) });
  }
}
