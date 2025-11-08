// pages/api/generate-resume.js
// HireEdge – AI CV generator
// - name centred
// - contact line under name
// - safer parsing for PDFs that start with "SKILLS"
// - avoids re-appending whole CV after EDUCATION
// - supports paste (JSON) and upload (multipart)

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

// ---------- 1) smarter CV parser ----------
function parsePastedCv(raw = "") {
  // clean: remove CR, remove lines that are just numbers
  const cleaned = raw
    .replace(/\r/g, "\n")
    .replace(/^\s*\d+\s*$/gm, ""); // lone 1 / 2 / 3

  const lines = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // words that are clearly not names
  const badHeadings = new Set([
    "skills",
    "summary",
    "profile",
    "profile summary",
    "experience",
    "professional experience",
    "education",
  ]);

  // try to find a line that looks like a real name
  let fullName =
    lines.find((l) => {
      const lower = l.toLowerCase();
      if (badHeadings.has(lower)) return false;
      const parts = l.split(/\s+/);
      if (parts.length < 2 || parts.length > 5) return false;
      // only letters and some punctuation
      if (!/^[a-z ,.'-]+$/i.test(l)) return false;
      return true;
    }) || "Candidate";

  // contact bits
  const emailLine = lines.find((l) => l.includes("@"));
  const phoneLine = lines.find((l) => /\+?\d[\d\s-]{7,}/.test(l));
  const locationLine = lines.find((l) =>
    /(london|united kingdom|uk|sw\d)/i.test(l)
  );
  const linkedinLine = lines.find((l) =>
    /linkedin\.com/i.test(l)
  );

  const contactParts = [];
  if (locationLine) contactParts.push(locationLine);
  if (phoneLine) contactParts.push(phoneLine.replace(/\s+/g, " "));
  if (emailLine) contactParts.push(emailLine);
  if (linkedinLine) contactParts.push(linkedinLine);

  const contactLine = contactParts.join(" | ");

  // sections
  const summaryMatch = cleaned.match(/summary\s*\n([\s\S]*?)(experience|education|skills)/i);
  const summaryText = summaryMatch ? summaryMatch[1].trim() : "";

  const expMatch = cleaned.match(/experience\s*\n([\s\S]*?)(education|skills|profile|certifications|$)/i);
  const expText = expMatch ? expMatch[1].trim() : "";

  // education: take only first 15 lines after "education"
  let eduText = "";
  const eduMatch = cleaned.match(/education\s*\n([\s\S]*)/i);
  if (eduMatch) {
    const eduLines = eduMatch[1]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      // drop lines that clearly look like start of CV again
      .filter(
        (l) =>
          !/linkedin\.com/i.test(l) &&
          !/^\s*(summary|skills|experience)\s*$/i.test(l)
      )
      .slice(0, 15);
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

// ---------- 2) read uploaded file (supports filepath/path, arrays) ----------
async function readUploadedFile(file) {
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

  return fs.readFileSync(filepath, "utf8");
}

// ---------- 3) AI helpers ----------
async function rewriteSummary({ currentSummary, jd }) {
  const client = getOpenAIClient();
  if (!client) {
    return (
      currentSummary ||
      "Motivated, customer-focused professional aligned to the target role."
    );
  }

  const prompt = `
You are a UK CV writer.
Rewrite this summary so it is 3–4 sentences, ATS-friendly, and aligned to the job description.
Do NOT add fake achievements.

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
Rewrite this experience section in UK CV style.
Keep the same real jobs.
Add 3–5 bullets per job that show ownership, relationship management, sales mindset, and alignment to the JD.

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
Use UK/ATS-friendly names.
Keep it believable for someone with this background.

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

// ---------- 4) handler ----------
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

    // ---- multipart (upload) ----
    if (contentType.includes("multipart/form-data")) {
      const form = formidable({ multiples: false, keepExtensions: true });
      const { fields, files } = await new Promise((resolve, reject) => {
        form.parse(req, (err, flds, fls) => {
          if (err) reject(err);
          else resolve({ fields: flds, files: fls });
        });
      });

      // accept many possible field names, or first file
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
      // ---- JSON (paste) ----
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

    // clamp very long
    if (cvText.length > 15000) cvText = cvText.slice(0, 15000);
    if (jdText.length > 4000) jdText = jdText.slice(0, 4000);

    // parse original CV to get name + sections
    const parsed = parsePastedCv(cvText);

    // AI parts
    const aiSummary = await rewriteSummary({
      currentSummary: parsed.summaryText || cvText.slice(0, 500),
      jd: jdText,
    });

    const alignedExperience = await alignExperience({
      expText: parsed.expText || cvText,
      jd: jdText,
    });

    const skillsLine = await buildSkills({ cvText, jd: jdText });

    // education — already trimmed in parser
    const eduBlock =
      parsed.eduText || "Education details available on request.";

    // build DOCX
    const children = [];

    // 1) NAME
    children.push(centerHeading(parsed.fullName || "Candidate", 40));

    // 2) CONTACT LINE (under name)
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
    return res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error("generate-resume error:", err);
    return res.status(500).json({
      error: "AI resume generation failed",
      details: String(err),
    });
  }
}
