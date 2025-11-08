// pages/api/generate-resume.js
// HireEdge – AI CV generator (upload + paste)
// fixes:
// - real human name at top, centred
// - single contact line under name
// - no random “1/2/3” lines
// - education trimmed (no duplicate CV at bottom)

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

let mammoth;   // lazy load for .docx
let pdfParse;  // lazy load for .pdf

const ALLOWED_ORIGIN = "https://hireedge.co.uk";
const S = (v) => (v ?? "").toString().trim();

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

// ---------- 1) SMART PARSER ----------
function parsePastedCv(raw = "") {
  // remove CR, remove orphan numbers
  const cleaned = raw
    .replace(/\r/g, "\n")
    .replace(/^\s*\d+\s*$/gm, ""); // lines that are only “1”, “2”, “3”

  const lines = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // find a human name anywhere (uploads sometimes start with experience)
  const badTokens = [
    "bengaluru",
    "india",
    "private",
    "limited",
    "ltd",
    "advisory",
    "manager",
    "counsellor",
    "experience",
    "education",
    "profile",
    "summary",
    "skills",
    "upgrad",
    "colife",
  ];

  let fullName =
    lines.find((l) => {
      const lower = l.toLowerCase();
      // skip obvious headings / companies
      if (badTokens.some((b) => lower.includes(b))) return false;
      // name should be 2–4 words
      const parts = l.split(/\s+/);
      if (parts.length < 2 || parts.length > 4) return false;
      // words only letters/punct
      if (!parts.every((w) => /^[a-z'.-]+$/i.test(w))) return false;
      return true;
    }) || "Candidate";

  // build contact line — take at most 1 of each
  let location = "";
  let phone = "";
  let email = "";
  let linkedin = "";

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!location && /(london|uk|united kingdom|sw\d)/i.test(line)) {
      location = line;
    }
    if (!phone && /\+?\d[\d\s-]{7,}/.test(line)) {
      phone = line.replace(/\s+/g, " ");
    }
    if (!email && line.includes("@")) {
      email = line;
    }
    if (!linkedin && /linkedin\.com/i.test(lower)) {
      linkedin = line;
    }
  }

  const contactParts = [location, phone, email, linkedin].filter(Boolean);
  const contactLine = contactParts.join(" | ");

  // SUMMARY
  const summaryMatch = cleaned.match(/summary\s*\n([\s\S]*?)(experience|education|skills)/i);
  const summaryText = summaryMatch ? summaryMatch[1].trim() : "";

  // EXPERIENCE
  const expMatch = cleaned.match(/experience\s*\n([\s\S]*?)(education|skills|profile|certifications|$)/i);
  const expText = expMatch ? expMatch[1].trim() : "";

  // EDUCATION (trim it!)
  let eduText = "";
  const eduMatch = cleaned.match(/education\s*\n([\s\S]*)/i);
  if (eduMatch) {
    const eduLines = eduMatch[1]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      // drop obvious restarts
      .filter(
        (l) =>
          !/linkedin\.com/i.test(l) &&
          !/^(summary|skills|experience)$/i.test(l) &&
          !/^(srina|srinath|senthilkumar)/i.test(l)
      )
      .slice(0, 6); // cap to first 6 lines
    eduText = eduLines.join("\n");
  }

  return {
    fullName,
    contactLine,
    summaryText,
    expText,
    eduText,
  };
}

// ---------- 2) read uploaded file ----------
async function readUploadedFile(file) {
  const filepath = file.filepath || file.path;
  if (!filepath) throw new Error("Uploaded file has no filepath/path");

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

// ---------- 3) AI helpers ----------
async function rewriteSummary({ currentSummary, jd }) {
  const client = getOpenAIClient();
  if (!client) {
    return (
      currentSummary ||
      "Motivated, customer-focused professional aligned to performance-based sales roles."
    );
  }

  const prompt = `
You are a UK CV writer.
Rewrite this summary to match the job description.
Keep it true, 3–4 sentences, ATS-friendly.

Current summary:
"""${currentSummary}"""

Job description:
"""${jd}"""

Return ONLY the summary.
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
  if (!client) return expText;

  const prompt = `
Rewrite the candidate's experience in UK CV format.
Keep real jobs, but make bullets show sales mindset, ownership, client interaction, and alignment to this JD.

Candidate experience:
"""${expText}"""

Job description:
"""${jd}"""

Return ONLY the formatted experience.
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
    return "Client Relationship Management • Sales Support • Stakeholder Engagement • Customer Service • Problem Solving • Time Management • Teamwork";
  }

  const prompt = `
From this candidate CV and job description, output ONE line of 10–14 skills separated by " • ".
Keep it realistic for someone coming from counselling / property / business development.

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

    // ---- upload (multipart) ----
    if (contentType.includes("multipart/form-data")) {
      const form = formidable({ multiples: false, keepExtensions: true });
      const { fields, files } = await new Promise((resolve, reject) => {
        form.parse(req, (err, flds, fls) => {
          if (err) reject(err);
          else resolve({ fields: flds, files: fls });
        });
      });

      // accept different fieldnames, or just first file
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
      // ---- paste (JSON) ----
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

    // stop huge bodies
    if (cvText.length > 15000) cvText = cvText.slice(0, 15000);
    if (jdText.length > 4000) jdText = jdText.slice(0, 4000);

    // parse CV into sections
    const parsed = parsePastedCv(cvText);

    // build AI parts
    const aiSummary = await rewriteSummary({
      currentSummary: parsed.summaryText || cvText.slice(0, 400),
      jd: jdText,
    });
    const alignedExperience = await alignExperience({
      expText: parsed.expText || cvText,
      jd: jdText,
    });
    const skillsLine = await buildSkills({ cvText, jd: jdText });

    const eduBlock =
      parsed.eduText || "Education details available on request.";

    // ----- build DOCX -----
    const children = [];

    // name
    children.push(centerHeading(parsed.fullName || "Candidate", 40));

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

    // summary
    children.push(label("PROFILE SUMMARY"));
    children.push(para(aiSummary));

    // skills
    children.push(label("KEY SKILLS"));
    children.push(para(skillsLine));

    // experience
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
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error("generate-resume error:", err);
    res.status(500).json({
      error: "AI resume generation failed",
      details: String(err),
    });
  }
}
