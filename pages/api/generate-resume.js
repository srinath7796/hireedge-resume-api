// pages/api/generate-resume.js
// HireEdge – CV generator (paste OR upload) with clean header + JD alignment

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

// lazy heavy imports (only when we really have a file)
let mammoth;   // for .docx
let pdfParse;  // for .pdf

// your framer domain
const ALLOWED_ORIGIN = "https://hireedge.co.uk";

// handy trim
const S = (v) => (v ?? "").toString().trim();

// tell Next.js we want to handle multipart ourselves
export const config = {
  api: {
    bodyParser: false,
  },
};

// ---------- OPENAI ----------
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ---------- DOCX helper paragraphs ----------
const centerHeading = (txt, size = 36) =>
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

const sectionTitle = (txt) =>
  new Paragraph({
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text: txt, bold: true })],
  });

const p = (txt) => new Paragraph({ children: [new TextRun(txt)] });
const b = (txt) => new Paragraph({ text: txt, bullet: { level: 0 } });

// ---------- 1. TEXT NORMALISER / PARSER ----------
function normaliseLines(raw = "") {
  return raw
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    // drop empty + page numbers like "1", "2", "3"
    .filter((l) => l && !/^[0-9]{1,3}$/.test(l));
}

function parsePastedCv(raw = "") {
  const lines = normaliseLines(raw);
  if (!lines.length) {
    return {
      fullName: "",
      contactLine: "",
      summaryText: "",
      expText: "",
      eduText: "",
      raw: raw,
    };
  }

  // 1) name = first non-empty that is not all caps number
  const fullName = lines[0];

  // 2) collect up to 3 lines after name that look like contact
  const contactParts = [];
  for (let i = 1; i < Math.min(lines.length, 6); i++) {
    const l = lines[i];
    if (!l) break;
    // stop if we hit a section word
    if (
      /^(profile|summary|professional summary|experience|work experience|education|skills)/i.test(
        l
      )
    ) {
      break;
    }
    // must have a digit OR '@' OR 'www' OR 'linkedin'
    if (/[0-9@]|linkedin|www|\.com/i.test(l)) {
      contactParts.push(l);
    }
  }

  // de-dupe contacts
  const contactLine = Array.from(new Set(contactParts)).join(" | ");

  // 3) try to slice sections
  const whole = raw;
  const summaryMatch = whole.match(/(profile|summary)\s*\n([\s\S]*?)(experience|work experience|education|skills|$)/i);
  const summaryText = summaryMatch ? S(summaryMatch[2]) : "";

  const expMatch = whole.match(/(experience|work experience)\s*\n([\s\S]*?)(education|skills|certificates|$)/i);
  const expText = expMatch ? S(expMatch[2]) : "";

  const eduMatch = whole.match(/education\s*\n([\s\S]*)$/i);
  const eduText = eduMatch ? S(eduMatch[1]) : "";

  return {
    fullName,
    contactLine,
    summaryText,
    expText,
    eduText,
    raw: raw,
  };
}

// ---------- 2. FILE → TEXT ----------
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

  // fallback → text
  return fs.readFileSync(file.filepath, "utf8");
}

// ---------- 3. AI HELPERS ----------
async function aiSummary({ currentSummary, jd, targetTitle }) {
  const client = getOpenAIClient();
  if (!client) {
    return (
      currentSummary ||
      `Motivated professional aligned to the role of ${targetTitle || "the position"}.`
    );
  }

  // protect against huge JD
  const shortJD = (jd || "").slice(0, 2000);

  const prompt = `
You are a UK CV writer.
Rewrite the candidate's summary so it is 3–4 sentences, ATS-friendly, and aligned to this job.
Keep it true to candidate — don't invent jobs or numbers.

Candidate summary:
"""${currentSummary || ""}"""

Job description:
"""${shortJD}"""

Return ONLY the final summary.
`;

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
    return "Customer Engagement • Relationship Building • Sales Strategy • Reporting • Stakeholder Management";
  }

  const shortJD = (jd || "").slice(0, 1200);

  const prompt = `
Make ONE line of 10–14 skills, separated by " • ".
Use skills that appear in the CV, and add the most relevant from the JD (if transferable).

CV:
"""${cvText.slice(0, 2000)}"""

JD:
"""${shortJD}"""
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.25,
  });

  return resp.choices[0].message.content.trim();
}

async function aiExperience({ expText, jd }) {
  const client = getOpenAIClient();
  if (!client) {
    // simple fallback → keep what user had
    return expText || "Experience available on request.";
  }

  const shortJD = (jd || "").slice(0, 1600);

  const prompt = `
Rewrite the candidate's EXPERIENCE so it keeps the same jobs but sounds closer to the JD.
Keep job titles, companies and dates if present.
Return in resume format (job heading + bullets).
Do NOT invent fake employers or dates.

Candidate experience:
"""${expText.slice(0, 4000)}"""

Job description:
"""${shortJD}"""
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4,
  });

  return resp.choices[0].message.content.trim();
}

// turn an AI experience block (text) into docx paragraphs
function experienceBlockToParagraphs(text = "") {
  const out = [];
  const lines = normaliseLines(text);
  lines.forEach((line) => {
    if (line.startsWith("- ") || line.startsWith("•")) {
      out.push(b(line.replace(/^[-•]\s?/, "")));
    } else {
      out.push(p(line));
    }
  });
  return out;
}

// ---------- 4. MAIN HANDLER ----------
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "HireEdge resume API is live ✅" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const contentType = req.headers["content-type"] || "";
    let cvText = "";
    let jdText = "";
    let userEmail = "";

    // ---- A) multipart (Framer upload button) ----
    if (contentType.includes("multipart/form-data")) {
      const form = formidable({ multiples: false, keepExtensions: true });

      const { fields, files } = await new Promise((resolve, reject) => {
        form.parse(req, (err, fields, files) => {
          if (err) reject(err);
          else resolve({ fields, files });
        });
      });

      // user might have sent JSON-like fields without a file → handle that
      const file =
        files.cvFile ||
        files.cv ||
        files.file ||
        (Array.isArray(files) ? files[0] : null);

      if (file && file.filepath) {
        cvText = await readUploadedFile(file);
      } else {
        // no actual file → look for text fields
        cvText =
          S(fields.cvText) ||
          S(fields.oldCvText) ||
          S(fields.pastedCv) ||
          "";
      }

      jdText = S(fields.jobDescription || fields.jd);
      userEmail = S(fields.email || fields.userEmail);
    } else {
      // ---- B) regular JSON (pasted CV) ----
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      cvText = S(body.cvText || body.oldCvText || body.pastedCv);
      jdText = S(body.jobDescription || body.jd);
      userEmail = S(body.email);
    }

    if (!cvText) {
      return res.status(400).json({ error: "No CV text found" });
    }

    // 1) parse what user sent
    const parsed = parsePastedCv(cvText);

    // 2) AI bits
    const summary = await aiSummary({
      currentSummary: parsed.summaryText || cvText.slice(0, 400),
      jd: jdText,
      targetTitle: "",
    });

    const skillsLine = await aiSkills({ cvText, jd: jdText });
    const expAligned = await aiExperience({
      expText: parsed.expText || cvText,
      jd: jdText,
    });

    // 3) education → keep user's if we have, else simple
    const educationBlock =
      parsed.eduText ||
      "Education details available on request.";

    // ---------- BUILD DOCX ----------
    const children = [];

    // name
    const safeName =
      parsed.fullName && !/^[0-9]+$/.test(parsed.fullName)
        ? parsed.fullName
        : "Candidate";

    children.push(centerHeading(safeName, 40));

    // contact
    const contactBits = [];
    if (parsed.contactLine) contactBits.push(parsed.contactLine);
    if (userEmail && !parsed.contactLine?.includes(userEmail)) {
      contactBits.push(userEmail);
    }
    const contactLine = Array.from(new Set(contactBits)).join(" | ");
    if (contactLine) {
      children.push(centerLine(contactLine));
    }

    // profile
    children.push(sectionTitle("PROFILE SUMMARY"));
    children.push(p(summary));

    // skills
    children.push(sectionTitle("KEY SKILLS"));
    children.push(p(skillsLine));

    // experience
    children.push(sectionTitle("PROFESSIONAL EXPERIENCE"));
    experienceBlockToParagraphs(expAligned).forEach((para) =>
      children.push(para)
    );

    // education
    children.push(sectionTitle("EDUCATION"));
    normaliseLines(educationBlock).forEach((line) => {
      children.push(p(line));
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
    console.error("❌ generate-resume error:", err);
    return res
      .status(500)
      .json({ error: "AI resume generation failed", details: String(err) });
  }
}
