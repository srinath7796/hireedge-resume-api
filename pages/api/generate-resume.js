// pages/api/generate-resume.js
// HireEdge - CV generator (paste + upload) with robust file handling

import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import OpenAI from "openai";
import formidable from "formidable";
import { promises as fsp } from "fs";
import path from "path";

let mammoth;   // for .docx
let pdfParse;  // for .pdf

// ---------- CORS ----------
const DEFAULT_ALLOWED_ORIGINS = [
  "https://hireedge.co.uk",
  "https://www.hireedge.co.uk",
  "https://app.hireedge.co.uk",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const EXPOSED_HEADERS = [
  "Content-Disposition",
  "X-Resume-Meta",
  "X-Resume-Timings",
];

function detectResponseFormat({ preferred, header }) {
  const normalised = (preferred || "").toString().trim().toLowerCase();
  if (normalised === "json") return "json";
  if (normalised === "docx" || normalised === "document") return "docx";

  if (
    typeof header === "string" &&
    header.toLowerCase().includes("application/json")
  ) {
    return "json";
  }

  return "docx";
}

function resolveAllowedOrigins() {
  const configured = (process.env.RESUME_API_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const combined =
    configured.length > 0
      ? [...configured, ...DEFAULT_ALLOWED_ORIGINS]
      : DEFAULT_ALLOWED_ORIGINS;

  return Array.from(new Set(combined));
}

const ALLOWED_ORIGINS = resolveAllowedOrigins();

function resolveOriginHeader(reqOrigin) {
  if (!reqOrigin) return ALLOWED_ORIGINS[0] || "*";
  if (ALLOWED_ORIGINS.includes(reqOrigin)) return reqOrigin;
  return ALLOWED_ORIGINS[0] || "*";
}

// small helper
const S = (v) => (v ?? "").toString().trim();

const firstDefined = (...values) => {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
};

const toScalar = (value) => (Array.isArray(value) ? value[0] : value);

function coerceBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();
    if (!normalised) return null;
    if (["true", "1", "yes", "y", "on"].includes(normalised)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalised)) return false;
  }
  return null;
}

function resolveBooleanPreference(value, defaultValue) {
  const coerced = coerceBoolean(toScalar(value));
  return coerced === null ? defaultValue : coerced;
}

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

function safeFilenameSegment(value) {
  return (value || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]+/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join("_")
    .replace(/_+/g, "_");
}

// ---------- parse pasted CV quickly ----------
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_REGEX = /(?:(?:\+?\d{1,3}[\s-]?)?(?:\(\d{1,4}\)[\s-]?)?\d{3,4}[\s-]?\d{3,4}[\s-]?\d{0,4})/;
const LINKEDIN_REGEX = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[A-Z0-9._\-\/#%]+/i;
const GITHUB_REGEX = /(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Z0-9._\-\/#%]+/i;
const URL_REGEX = /https?:\/\/[^\s)]+/i;
const LOCATION_HINT_REGEX = /\b(?:based|located|residing) in\b/i;

const KEYWORD_TOKEN_REGEX = /[A-Z][A-Z0-9+#/&.-]+/gi;
const COMMON_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "into",
  "your",
  "their",
  "about",
  "have",
  "will",
  "skills",
  "experience",
  "responsibilities",
  "requirements",
  "job",
  "role",
  "team",
  "work",
  "ability",
  "including",
  "using",
  "knowledge",
  "strong",
  "excellent",
  "support",
  "services",
  "within",
]);

function keywordFrequencies(text = "") {
  const counts = new Map();
  const tokens = text.match(KEYWORD_TOKEN_REGEX) || [];
  tokens.forEach((tokenRaw) => {
    const token = tokenRaw.toLowerCase();
    if (token.length < 3) return;
    if (COMMON_STOPWORDS.has(token)) return;
    const clean = token.replace(/^[-./]+|[-./]+$/g, "");
    if (!clean) return;
    counts.set(clean, (counts.get(clean) || 0) + 1);
  });
  return counts;
}

function deriveKeywordInsights({ cvText = "", jdText = "" }) {
  if (!jdText.trim()) return null;

  const cvCounts = keywordFrequencies(cvText);
  const jdCounts = keywordFrequencies(jdText);

  const sortedJd = Array.from(jdCounts.entries())
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  const strengths = [];
  const gaps = [];

  sortedJd.forEach(([keyword]) => {
    if (cvCounts.has(keyword)) {
      if (strengths.length < 8) strengths.push(keyword);
    } else if (gaps.length < 8) {
      gaps.push(keyword);
    }
  });

  if (strengths.length === 0 && gaps.length === 0) return null;

  const summaryParts = [];
  if (strengths.length > 0) {
    summaryParts.push(
      `Strong overlap with ${strengths.slice(0, 3).join(", ")}.`
    );
  }
  if (gaps.length > 0) {
    summaryParts.push(
      `Consider weaving in evidence for ${gaps.slice(0, 3).join(", ")}.`
    );
  }

  return {
    matchedKeywords: strengths,
    missingKeywords: gaps,
    summary: summaryParts.join(" ").trim(),
  };
}

function normaliseUrl(url) {
  if (!url) return "";
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/$/, "");
  }
  return `https://${trimmed.replace(/\/$/, "")}`;
}

function formatContactUrl(url, label) {
  const normalised = normaliseUrl(url);
  if (!normalised) return "";
  const display = normalised
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "");
  return label ? `${label}: ${display}` : display;
}

function isLikelyLocation(line) {
  const candidate = (line || "").trim();
  if (!candidate) return false;
  if (candidate.length > 64) return false;
  if (EMAIL_REGEX.test(candidate)) return false;
  if (URL_REGEX.test(candidate)) return false;
  if (/\d{3,}/.test(candidate)) return false;
  return candidate.includes(",") || LOCATION_HINT_REGEX.test(candidate);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSection(text, startKeywords, endKeywords = []) {
  const start = startKeywords.map(escapeRegex).join("|");
  const startPattern = `(?:^|\n)\s*(?:${start})\s*\n([\s\S]*?)`;

  let pattern;
  if (endKeywords.length > 0) {
    const end = endKeywords.map(escapeRegex).join("|");
    pattern = new RegExp(`${startPattern}(?=\n\s*(?:${end})\s*\n|$)`, "i");
  } else {
    pattern = new RegExp(`${startPattern}$`, "i");
  }

  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}

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

  const contactOrdered = [];
  const contactSeen = new Set();
  const addContact = (value) => {
    const clean = (value || "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (contactSeen.has(key)) return;
    contactSeen.add(key);
    contactOrdered.push(clean);
  };

  if (emailMatch) addContact(emailMatch[0]);
  if (phoneMatch) {
    const digits = phoneMatch[0].replace(/\D/g, "");
    if (digits.length >= 7) {
      addContact(phoneMatch[0]);
    }
  }

  const topWindow = lines.slice(0, 12);
  for (const line of topWindow) {
    if (!line) continue;
    if (line === fullName) continue;

    const linkedInMatch = line.match(LINKEDIN_REGEX);
    if (linkedInMatch) {
      addContact(formatContactUrl(linkedInMatch[0], "LinkedIn"));
      continue;
    }

    const githubMatch = line.match(GITHUB_REGEX);
    if (githubMatch) {
      addContact(formatContactUrl(githubMatch[0], "GitHub"));
      continue;
    }

    const genericUrlMatch = line.match(URL_REGEX);
    if (genericUrlMatch) {
      const labelled = /portfolio|site|blog|profile|website/i.test(line)
        ? formatContactUrl(genericUrlMatch[0], "Portfolio")
        : formatContactUrl(genericUrlMatch[0]);
      addContact(labelled);
      continue;
    }

    if (isLikelyLocation(line)) {
      addContact(line);
      continue;
    }
  }

  topLines
    .filter((line) => line && line !== fullName)
    .slice(0, 2)
    .forEach((line) => addContact(line));

  const contactLine = contactOrdered.join(" • ");

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

  const volunteerText = extractSection(
    txt,
    ["volunteer", "volunteering", "community"],
    ["skills", "awards", "interests", "hobbies"]
  );

  const awardsText = extractSection(
    txt,
    ["awards", "honours", "honors", "recognition"],
    ["skills", "projects", "volunteer", "interests"]
  );

  const publicationsText = extractSection(
    txt,
    ["publications", "research", "papers", "articles"],
    ["skills", "projects", "volunteer", "awards", "interests"]
  );

  const developmentText = extractSection(
    txt,
    [
      "professional development",
      "development",
      "continuing education",
      "learning",
    ],
    ["skills", "projects", "certifications", "training", "interests"]
  );

  const languagesText = extractSection(
    txt,
    ["languages", "language skills"],
    ["skills", "projects", "interests", "hobbies"]
  );

  const interestsText = extractSection(
    txt,
    ["interests", "hobbies", "additional information"],
    ["references", "appendix", "referees"]
  );

  return {
    fullName,
    contactLine,
    summaryText,
    expText,
    eduText,
    projectsText,
    certificationsText,
    volunteerText,
    awardsText,
    publicationsText,
    developmentText,
    languagesText,
    interestsText,
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

  let text = "";

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
  } finally {
    await safeDelete(realPath);
  }

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

function timedRun({ key, timeoutLabel, timeoutMs, task, timings }) {
  const startedAt = Date.now();
  return runWithTimeout(task, { ms: timeoutMs, label: timeoutLabel }).finally(() => {
    timings[key] = Date.now() - startedAt;
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

  const prompt = [
    "You are a UK CV writer.",
    "",
    "Rewrite the candidate summary so it stays true to them but aligns to this job.",
    targetTitle
      ? `3-4 sentences. ATS-friendly. Reference the ${targetTitle} role explicitly.`
      : "3-4 sentences. ATS-friendly. No waffle.",
    "",
    "Candidate summary:",
    `"""${trimmedCv}"""`,
    "",
    "Job description:",
    `"""${trimmedJd}"""`,
    "",
    "Return ONLY the summary.",
  ].join("\n");

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

  const prompt = [
    "Take the candidate experience below and rewrite it into UK-CV style.",
    "- KEEP the same jobs (don't invent companies / dates)",
    "- 3-5 bullets per job",
    "- bias bullets toward this job description.",
    "",
    "Candidate experience:",
    `"""${trimmedExp}"""`,
    "",
    "Job description:",
    `"""${trimmedJd}"""`,
    "",
    "Return only the formatted experience.",
  ].join("\n");

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

  const prompt = [
    'Make one line of 10-14 skills separated by " • ".',
    "Use only skills that appear or are clearly transferable.",
    "",
    "CV:",
    `"""${trimmedCv}"""`,
    "",
    "JD:",
    `"""${trimmedJd}"""`,
  ].join("\n");

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
  });

  return resp.choices[0].message.content.trim();
}

function cleanTargetTitle(value = "") {
  return value.replace(/\s+/g, " ").replace(/[.,;:]+$/, "").trim();
}

function inferTargetTitle({
  explicit,
  jd,
  cv,
}) {
  const explicitClean = cleanTargetTitle(explicit);
  if (explicitClean) return explicitClean;

  const tryMatch = (pattern) => {
    if (!jd) return "";
    const match = jd.match(pattern);
    if (!match) return "";
    return cleanTargetTitle(match[1]);
  };

  const labelMatch =
    tryMatch(/(?:role|job title|position|title)\s*(?:[:\-])\s*([^\n]+)/i) ||
    tryMatch(/We are looking for an?\s+([^\n.,]+)/i);
  if (labelMatch) return labelMatch;

  const firstLineCandidate = (jd || "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && line.length < 80 && /[A-Za-z]/.test(line));
  const cleanFirstLine = cleanTargetTitle(firstLineCandidate || "");
  if (cleanFirstLine) return cleanFirstLine;

  const cvLine = (cv || "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /seeking|targeting|aspiring/i.test(line));
  const cleanCvLine = cleanTargetTitle(cvLine || "");
  if (cleanCvLine) return cleanCvLine;

  return "";
}

function pushSection(children, title, text, { treatBullets = true } = {}) {
  if (!text) return;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return;

  children.push(label(title));

  lines.forEach((line) => {
    const bulletPrefix = line.match(/^[•\-]\s*/);
    if (treatBullets && bulletPrefix) {
      children.push(bullet(line.replace(bulletPrefix[0], "")));
      return;
    }

    if (treatBullets && line.includes("•")) {
      line
        .split("•")
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .forEach((chunk) => children.push(bullet(chunk)));
      return;
    }

    children.push(para(line));
  });
}

// ---------- main handler ----------
export default async function handler(req, res) {
  // CORS
  const origin = resolveOriginHeader(req.headers.origin);
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    ["Content-Type", "Authorization", "X-Requested-With"].join(", ")
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    EXPOSED_HEADERS.join(", ")
  );
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");

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
    let providedTitle = "";
    let responsePreference = "";
    let includeDocumentPreference;

    if (contentType.includes("multipart/form-data")) {
      // ---------- UPLOAD ----------
      mode = "upload";
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
      responsePreference = S(
        fields.responseFormat || fields.responseType || fields.format
      );
      includeDocumentPreference = toScalar(
        firstDefined(
          fields.includeDocument,
          fields.includeDoc,
          fields.attachDoc,
          fields.attachDocument
        )
      );
      providedTitle = S(
        fields.jobTitle ||
          fields.role ||
          fields.targetRole ||
          fields.targetTitle ||
          fields.position
      );

    } else {
      // ---------- PASTE ----------
      let body = req.body;
      if (typeof req.body === "string") {
        try {
          body = JSON.parse(req.body);
        } catch (parseErr) {
          return res.status(400).json({
            error: "Invalid JSON body",
            details: parseErr.message,
          });
        }
      }
      if (!body || typeof body !== "object") {
        body = {};
      }

      cvText = S(body.cvText || body.oldCvText || body.pastedCv);
      jdText = S(body.jd || body.jobDescription);
      userEmail = S(body.email);
      mode = S(body.mode || "paste");
      providedTitle = S(
        body.jobTitle ||
          body.role ||
          body.targetRole ||
          body.targetTitle ||
          body.position
      );
      responsePreference = S(
        body.responseFormat ||
          body.responseType ||
          body.format ||
          body.returnFormat
      );
      includeDocumentPreference = firstDefined(
        body.includeDocument,
        body.includeDoc,
        body.attachDoc,
        body.attachDocument
      );
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

    const responseFormat = detectResponseFormat({
      preferred: responsePreference,
      header: req.headers.accept,
    });

    const includeDocument =
      responseFormat === "docx"
        ? true
        : resolveBooleanPreference(includeDocumentPreference, true);

    // parse pasted cv
    const parsed = parsePastedCv(cvText);
    const targetTitle = inferTargetTitle({
      explicit: providedTitle,
      jd: jdText,
      cv: cvText,
    });

    // AI parts
    const summaryFallback = parsed.summaryText || cvText.slice(0, 500);
    const experienceFallback = parsed.expText || cvText;

    const timings = {};
    const [summaryResult, experienceResult, skillsResult] = await Promise.allSettled([
      timedRun({
        key: "summaryMs",
        timeoutLabel: "Summary rewrite",
        timeoutMs: 15000,
        task: () =>
          rewriteSummary({
            currentSummary: summaryFallback,
            jd: jdText,
            targetTitle,
          }),
        timings,
      }),
      timedRun({
        key: "experienceMs",
        timeoutLabel: "Experience alignment",
        timeoutMs: 20000,
        task: () =>
          alignExperience({
            expText: experienceFallback,
            jd: jdText,
          }),
        timings,
      }),
      timedRun({
        key: "skillsMs",
        timeoutLabel: "Skills extraction",
        timeoutMs: 10000,
        task: () => buildSkills({ cvText, jd: jdText }),
        timings,
      }),
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

    const aiSummary =
      summaryResult.status === "fulfilled"
        ? summaryResult.value
        : summaryFallback;

    const alignedExp =
      experienceResult.status === "fulfilled"
        ? experienceResult.value
        : experienceFallback;

    const skillsLine =
      skillsResult.status === "fulfilled"
        ? skillsResult.value
        : "Customer Service • Stakeholder Management • Time Management • Problem Solving";

    const roleInsights = deriveKeywordInsights({ cvText, jdText });

    const meta = {
      mode,
      targetTitle: targetTitle || null,
      summarySource: summaryResult.status === "fulfilled" ? "ai" : "fallback",
      experienceSource:
        experienceResult.status === "fulfilled" ? "ai" : "fallback",
      skillsSource: skillsResult.status === "fulfilled" ? "ai" : "fallback",
      emailProvided: Boolean(userEmail),
      responseFormat,
      includeDocument,
    };

    if (roleInsights) {
      meta.roleInsights = {
        summary: roleInsights.summary,
        matchedKeywords: roleInsights.matchedKeywords.slice(0, 5),
        missingKeywords: roleInsights.missingKeywords.slice(0, 5),
      };
    }

    try {
      res.setHeader("X-Resume-Meta", JSON.stringify(meta));
      res.setHeader("X-Resume-Timings", JSON.stringify(timings));
    } catch (serialiseErr) {
      console.warn("Unable to serialise resume metadata", serialiseErr);
    }

    const eduBlock =
      parsed.eduText ||
      "Education details as provided by the candidate.";

    const projectBlock = parsed.projectsText;
    const certBlock = parsed.certificationsText;

    const sections = {
      summary: aiSummary,
      skills: skillsLine,
      experience: alignedExp,
      education: eduBlock,
      projects: projectBlock || "",
      certifications: certBlock || "",
      volunteer: parsed.volunteerText || "",
      awards: parsed.awardsText || "",
      publications: parsed.publicationsText || "",
      professionalDevelopment: parsed.developmentText || "",
      languages: parsed.languagesText || "",
      interests: parsed.interestsText || "",
    };

    if (roleInsights) {
      sections.roleInsights = roleInsights;
    }

    const contact = {
      name: parsed.fullName || "Candidate",
      contactLine: parsed.contactLine || "",
      targetTitle: targetTitle || "",
    };

    const filenameParts = ["HireEdge"];
    const nameSegment = safeFilenameSegment(contact.name);
    const roleSegment = safeFilenameSegment(targetTitle);
    if (nameSegment) filenameParts.push(nameSegment);
    if (roleSegment) filenameParts.push(roleSegment);
    const filename = `${filenameParts.join("_")}_CV.docx`;
    const DOCX_MIME =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    let docBuffer = null;

    if (responseFormat === "docx" || includeDocument) {
      const children = [];

      children.push(centerHeading(contact.name, 36, true));

      if (targetTitle) {
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 120 },
            children: [
              new TextRun({ text: targetTitle, italics: true, size: 24 }),
            ],
          })
        );
      }

      if (contact.contactLine) {
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
            children: [new TextRun(contact.contactLine)],
          })
        );
      }

      children.push(label("PROFILE SUMMARY"));
      children.push(para(aiSummary));

      children.push(label("KEY SKILLS"));
      children.push(para(skillsLine));

      if (roleInsights) {
        children.push(label("ROLE-READY INSIGHTS"));
        if (roleInsights.summary) {
          children.push(para(roleInsights.summary));
        }
        if (roleInsights.matchedKeywords.length > 0) {
          children.push(
            para(
              `Strengths to spotlight: ${roleInsights.matchedKeywords
                .slice(0, 5)
                .join(", ")}.`
            )
          );
        }
        if (roleInsights.missingKeywords.length > 0) {
          children.push(para("Consider adding evidence for:"));
          roleInsights.missingKeywords.slice(0, 5).forEach((keyword) => {
            children.push(bullet(keyword));
          });
        }
      }

      pushSection(children, "PROFESSIONAL EXPERIENCE", alignedExp);

      pushSection(children, "EDUCATION", eduBlock, { treatBullets: false });

      pushSection(children, "PROJECTS", projectBlock);

      pushSection(children, "CERTIFICATIONS", certBlock, { treatBullets: false });
      pushSection(children, "VOLUNTEER EXPERIENCE", parsed.volunteerText);
      pushSection(children, "AWARDS", parsed.awardsText, { treatBullets: false });
      pushSection(children, "PUBLICATIONS", parsed.publicationsText);
      pushSection(children, "PROFESSIONAL DEVELOPMENT", parsed.developmentText, {
        treatBullets: false,
      });
      pushSection(children, "LANGUAGES", parsed.languagesText, {
        treatBullets: false,
      });
      pushSection(children, "INTERESTS", parsed.interestsText, {
        treatBullets: false,
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
      docBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    }

    if (responseFormat === "json") {
      const payload = {
        meta,
        timings,
        contact,
        sections,
      };

      if (roleInsights) {
        payload.insights = roleInsights;
      }

      if (includeDocument && docBuffer) {
        payload.document = {
          filename,
          mimeType: DOCX_MIME,
          base64: docBuffer.toString("base64"),
        };
      } else if (!includeDocument) {
        payload.document = null;
      }

      return res.status(200).json(payload);
    }

    if (!docBuffer) {
      return res
        .status(500)
        .json({ error: "Resume document generation failed" });
    }

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(filename)}"`
    );
    res.setHeader("Content-Type", DOCX_MIME);

    return res.status(200).send(docBuffer);
  } catch (err) {
    console.error("generate-resume error:", err);
    return res.status(500).json({
      error: "AI resume generation failed",
      details: String(err),
    });
  }
}
