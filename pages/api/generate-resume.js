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
import { promises as fsp } from "fs";
import path from "path";

let mammoth;   // for .docx
let pdfParse;  // for .pdf

// your framer domain
const ALLOWED_ORIGIN = "https://hireedge.co.uk";
// ---------- CORS ----------
const DEFAULT_ALLOWED_ORIGINS = ["https://hireedge.co.uk"];

function resolveAllowedOrigins() {
  const configured = (process.env.RESUME_API_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return configured.length > 0 ? configured : DEFAULT_ALLOWED_ORIGINS;
}

const ALLOWED_ORIGINS = resolveAllowedOrigins();

function resolveOriginHeader(reqOrigin) {
  if (!reqOrigin) return ALLOWED_ORIGINS[0] || "*";
  if (ALLOWED_ORIGINS.includes(reqOrigin)) return reqOrigin;
  return ALLOWED_ORIGINS[0] || "*";
}

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
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_REGEX = /(?:(?:\+?\d{1,3}[\s-]?)?(?:\(\d{1,4}\)[\s-]?)?\d{3,4}[\s-]?\d{3,4}[\s-]?\d{0,4})/;

  // first non-empty line is usually the name
  const fullName = lines[0] || "Candidate";
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

  // second line is often contacts
  const contactLine = lines[1] || "";
function extractSection(text, startKeywords, endKeywords = []) {
  const start = startKeywords.map(escapeRegex).join("|");
  const startPattern = `(?:^|\n)\s*(?:${start})\s*\n([\s\S]*?)`;

  // sections
  const summaryMatch = txt.match(/summary\s*\n([\s\S]*?)(experience|employment|work history|education|skills|$)/i);
  const summaryText = summaryMatch ? summaryMatch[1].trim() : "";
  let pattern;
  if (endKeywords.length > 0) {
    const end = endKeywords.map(escapeRegex).join("|");
    pattern = new RegExp(`${startPattern}(?=\n\s*(?:${end})\s*\n|$)`, "i");
  } else {
    pattern = new RegExp(`${startPattern}$`, "i");
  }

  const expMatch = txt.match(/(experience|employment|work history)\s*\n([\s\S]*?)(education|skills|certifications|$)/i);
  const expText = expMatch ? expMatch[2].trim() : "";
  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}

  const eduMatch = txt.match(/education\s*\n([\s\S]*?)$/i);
  const eduText = eduMatch ? eduMatch[1].trim() : "";
function parsePastedCv(raw = "") {
  const txt = raw.replace(/\r/g, "\n").trim();
  const lines = txt.split("\n").map((l) => l.trim());
  const nonEmptyLines = lines.filter(Boolean);

  const emailMatch = txt.match(EMAIL_REGEX);
  const phoneMatch = txt.match(PHONE_REGEX);

  const fullName =
    nonEmptyLines.find((line) => {
      if (!line) return false;
      if (line.length > 80) return false;
      if (EMAIL_REGEX.test(line)) return false;
      if (/\d/.test(line)) return false;
      return true;
    }) || "Candidate";

  const topLines = [];
  for (const line of lines) {
    if (!line) break;
    topLines.push(line);
  }

  const contactPieces = new Set();
  if (emailMatch) contactPieces.add(emailMatch[0]);
  if (phoneMatch) {
    const digits = phoneMatch[0].replace(/\D/g, "");
    if (digits.length >= 7) {
      contactPieces.add(phoneMatch[0]);
    }
  }
  topLines
    .filter((line) => line && line !== fullName && !contactPieces.has(line))
    .slice(0, 2)
    .forEach((line) => contactPieces.add(line));

  const contactLine = Array.from(contactPieces).join(" • ");

  const summaryText = extractSection(txt, [
    "summary",
    "professional summary",
    "profile",
    "about me",
  ], [
    "experience",
    "employment",
    "work history",
    "professional experience",
    "education",
    "skills",
  ]);

  const expText = extractSection(
    txt,
    [
      "experience",
      "employment",
      "work history",
      "professional experience",
      "career history",
    ],
    ["education", "skills", "projects", "certifications", "training"]
  );

  const eduText = extractSection(
    txt,
    ["education", "academic background", "education & training"],
    ["skills", "projects", "certifications", "volunteer", "awards"]
  );

  const projectsText = extractSection(
    txt,
    ["projects", "selected projects", "project highlights"],
    ["skills", "certifications", "volunteer", "awards", "interests"]
  );

  const certificationsText = extractSection(
    txt,
    ["certifications", "licenses", "training"],
    ["skills", "projects", "volunteer", "awards"]
  );

  return {
    fullName,
    contactLine,
    summaryText,
    expText,
    eduText,
    projectsText,
    certificationsText,
  };
}

// ---------- upload parsers (robust) ----------
async function safeDelete(pathToDelete) {
  if (!pathToDelete) return;
  try {
    await fsp.unlink(pathToDelete);
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      console.warn("Failed to delete temp file", pathToDelete, err);
    }
  }
}

const ALLOWED_EXTENSIONS = new Set([".docx", ".pdf", ".txt"]);
const ALLOWED_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
  "text/plain",
]);

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
  let text = "";

  if (ext === ".pdf") {
    if (!pdfParse) {
      pdfParse = (await import("pdf-parse")).default;
  try {
    if (ext === ".docx") {
      if (!mammoth) {
        mammoth = (await import("mammoth")).default;
      }
      const result = await mammoth.extractRawText({ path: realPath });
      text = result.value || "";
    } else if (ext === ".pdf") {
      if (!pdfParse) {
        pdfParse = (await import("pdf-parse")).default;
      }
      const buffer = await fsp.readFile(realPath);
      const data = await pdfParse(buffer);
      text = data.text || "";
    } else {
      text = await fsp.readFile(realPath, "utf8");
    }
    const buffer = fs.readFileSync(realPath);
    const data = await pdfParse(buffer);
    return data.text || "";
  } finally {
    await safeDelete(realPath);
  }

  // fallback: try to read as text
  return fs.readFileSync(realPath, "utf8");
  return text;
}

// ---------- AI helpers ----------
async function runWithTimeout(task, { ms, label }) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${ms}ms`);
      error.name = "TimeoutError";
      reject(error);
    }, ms);

    Promise.resolve()
      .then(task)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
  });
}

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
@@ -204,177 +354,289 @@ async function buildSkills({ cvText, jd }) {
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
  const origin = resolveOriginHeader(req.headers.origin);
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  res.setHeader(
    "Access-Control-Allow-Headers",
    ["Content-Type", "Authorization", "X-Requested-With"].join(", ")
  );
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(204).end();
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
      const form = formidable({
        multiples: false,
        keepExtensions: true,
        maxFileSize: 8 * 1024 * 1024, // 8MB
        filter: ({ mimetype, originalFilename }) => {
          const ext = path.extname(originalFilename || "").toLowerCase();
          return (
            (!mimetype || ALLOWED_MIME_TYPES.has(mimetype)) &&
            (ext ? ALLOWED_EXTENSIONS.has(ext) : true)
          );
        },
      });

      let formError;
      form.on("error", (err) => {
        formError = err;
      });

      const { fields, files } = await new Promise((resolve, reject) => {
        form.parse(req, (err, fields, files) => {
          if (err) reject(err);
          else resolve({ fields, files });
        });
      });

      if (formError) {
        throw formError;
      }

      // your frontend sends "cvFile"
      const uploadedFile =
        files.cvFile ||
        files.cv ||
        files.file ||
        null;

      if (!uploadedFile) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const ext = path
        .extname(uploadedFile.originalFilename || "")
        .toLowerCase();
      const mimetype = uploadedFile.mimetype;

      if (
        (ext && !ALLOWED_EXTENSIONS.has(ext)) ||
        (mimetype && !ALLOWED_MIME_TYPES.has(mimetype))
      ) {
        return res.status(400).json({
          error:
            "Unsupported file type. Please upload a .docx, .pdf or .txt résumé.",
        });
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

    if (cvText.trim().split(/\s+/).length < 30) {
      return res.status(400).json({
        error:
          "We couldn't extract enough text from the CV. Please upload a text-based file.",
      });
    }

    // parse pasted cv
    const parsed = parsePastedCv(cvText);

    // AI parts
    const aiSummary = await rewriteSummary({
      currentSummary: parsed.summaryText || cvText.slice(0, 500),
      jd: jdText,
      targetTitle: "",
    });
    const summaryFallback = parsed.summaryText || cvText.slice(0, 500);
    const experienceFallback = parsed.expText || cvText;

    const [summaryResult, experienceResult, skillsResult] = await Promise.allSettled([
      runWithTimeout(
        () =>
          rewriteSummary({
            currentSummary: summaryFallback,
            jd: jdText,
            targetTitle: "",
          }),
        { ms: 15000, label: "Summary rewrite" }
      ),
      runWithTimeout(
        () =>
          alignExperience({
            expText: experienceFallback,
            jd: jdText,
          }),
        { ms: 20000, label: "Experience alignment" }
      ),
      runWithTimeout(
        () => buildSkills({ cvText, jd: jdText }),
        { ms: 10000, label: "Skills extraction" }
      ),
    ]);

    if (summaryResult.status === "rejected") {
      console.warn("Summary AI failed", summaryResult.reason);
    }
    if (experienceResult.status === "rejected") {
      console.warn("Experience AI failed", experienceResult.reason);
    }
    if (skillsResult.status === "rejected") {
      console.warn("Skills AI failed", skillsResult.reason);
    }

    const alignedExp = await alignExperience({
      expText: parsed.expText || cvText,
      jd: jdText,
    });
    const aiSummary =
      summaryResult.status === "fulfilled"
        ? summaryResult.value
        : summaryFallback;

    const skillsLine = await buildSkills({ cvText, jd: jdText });
    const alignedExp =
      experienceResult.status === "fulfilled"
        ? experienceResult.value
        : experienceFallback;

    const skillsLine =
      skillsResult.status === "fulfilled"
        ? skillsResult.value
        : "Customer Service • Stakeholder Management • Time Management • Problem Solving";

    const eduBlock =
      parsed.eduText ||
      "Education details as provided by the candidate.";

    const projectBlock = parsed.projectsText;
    const certBlock = parsed.certificationsText;

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

    if (projectBlock) {
      children.push(label("PROJECTS"));
      projectBlock
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .forEach((line) => {
          if (line.startsWith("•") || line.startsWith("-")) {
            children.push(bullet(line.replace(/^[-•]\s?/, "").trim()));
          } else {
            children.push(para(line));
          }
        });
    }

    if (certBlock) {
      children.push(label("CERTIFICATIONS"));
      certBlock
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .forEach((line) => children.push(para(line)));
    }

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

