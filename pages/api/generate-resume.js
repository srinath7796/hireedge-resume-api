// pages/api/generate-resume.js
// HireEdge - CV generator (paste + upload) with robust file handling

import {
  AlignmentType,
  BorderStyle,
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
const BODY_FONT = "Calibri";
const BODY_SIZE = 22;
const HEADING_COLOR = "1F2933";
const ACCENT_COLOR = "4B5563";
const DIVIDER_COLOR = "D1D5DB";

const createRun = (text, overrides = {}) =>
  new TextRun({
    text,
    font: BODY_FONT,
    size: BODY_SIZE,
    color: HEADING_COLOR,
    ...overrides,
  });

const centerHeading = (txt, size = 56, bold = true) =>
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
    children: [createRun(txt, { bold, size })],
  });

const label = (txt) =>
  new Paragraph({
    spacing: { before: 320, after: 160 },
    border: {
      bottom: {
        color: DIVIDER_COLOR,
        space: 4,
        size: 12,
        value: BorderStyle.SINGLE,
      },
    },
    children: [
      createRun(txt, { bold: true, allCaps: true, color: HEADING_COLOR }),
    ],
  });

const para = (txt, { alignment = AlignmentType.LEFT, spacing } = {}) =>
  new Paragraph({
    alignment,
    spacing: spacing || { after: 120 },
    children: [createRun(txt)],
  });

const bullet = (txt) =>
  new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 80 },
    children: [createRun(txt)],
  });

const dividerParagraph = () =>
  new Paragraph({
    children: [createRun(" ", { size: 2, color: DIVIDER_COLOR })],
    border: {
      bottom: {
        color: DIVIDER_COLOR,
        space: 4,
        size: 6,
        value: BorderStyle.SINGLE,
      },
    },
    spacing: { after: 200 },
  });

function buildContactParagraph(line = "") {
  const segments = line
    .split("•")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    const clean = line.trim();
    if (!clean) return null;
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [createRun(clean, { color: ACCENT_COLOR })],
    });
  }

  const runs = [];
  segments.forEach((segment, index) => {
    if (index > 0) {
      runs.push(createRun("  •  ", { bold: false, color: ACCENT_COLOR }));
    }
    runs.push(createRun(segment, { color: ACCENT_COLOR }));
  });

  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 160 },
    children: runs,
  });
}

function pushSkillLines(children, skillsLine = "") {
  const skills = skillsLine
    .split(/[•,]/)
    .map((skill) => skill.trim())
    .filter(Boolean);

  if (skills.length === 0) {
    if (skillsLine.trim()) {
      children.push(para(skillsLine, { alignment: AlignmentType.LEFT }));
    }
    return;
  }

  skills.forEach((skill) => {
    children.push(
      new Paragraph({
        bullet: { level: 0 },
        spacing: { after: 60 },
        children: [createRun(skill, { color: HEADING_COLOR })],
      })
    );
  });
}

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

function extractMetricPhrase(text = "") {
  if (!text) return "";
  const metricMatch = text.match(
    /(£\s?\d+[\d,]*|\d+%|\d+\s?(?:x|times)|\d+[\d,]*\s?(?:customers|users|clients|people))/i
  );
  return metricMatch ? metricMatch[0].trim() : "";
}

function fallbackImpactHighlights(source = "") {
  const lines = (source || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return [
      {
        headline: "Showcase one quantifiable achievement that proves your impact.",
        metric: "",
        proof:
          "Highlight a project where you delivered measurable results to stand out.",
      },
    ];
  }

  const priorityLines = lines.filter((line) => looksLikeBullet(line) || /\d/.test(line));
  const chosen = (priorityLines.length > 0 ? priorityLines : lines)
    .map((line) => line.replace(/^[•\-]\s*/, ""))
    .slice(0, 3);

  return chosen.map((headline, index) => ({
    headline,
    metric: extractMetricPhrase(headline),
    proof:
      index === 0
        ? "Frame this as a results-first bullet so hiring managers see your value instantly."
        : "Tie this story back to the employer's priorities for even more impact.",
  }));
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

function selectFullNameCandidate(lines = []) {
  const candidates = [];
  const limit = Math.min(lines.length, 40);

  for (let index = 0; index < limit; index += 1) {
    const original = lines[index];
    const line = (original || "").replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (line.length > 80) continue;
    if (EMAIL_REGEX.test(line)) continue;
    if (URL_REGEX.test(line)) continue;
    if (isLikelyLocation(line)) continue;
    if (/^\d+[).:-]?$/.test(line)) continue;

    const letterMatches = line.match(/[A-Za-z]/g) || [];
    if (letterMatches.length < 3) continue;

    const digitMatches = line.match(/\d/g) || [];
    if (digitMatches.length > 0) continue;

    const wordCount = line.split(/\s+/).filter(Boolean).length;
    let score = Math.max(0, 16 - index * 2);

    if (wordCount >= 2) score += 10;
    if (/[A-Z][a-z]+/.test(line)) score += 4;
    if (/[a-z]/.test(line)) score += 2;
    if (/['-]/.test(line)) score += 1;

    const allCapsLetters =
      letterMatches.length > 0 && line === line.toUpperCase();
    if (allCapsLetters) score -= 6;

    if (/summary|objective|profile|curriculum|experience/i.test(line)) {
      score -= 20;
    }

    candidates.push({ value: line, score });
  }

  if (candidates.length === 0) {
    const fallback = lines.find((original) => {
      const line = (original || "").replace(/\s+/g, " ").trim();
      if (!line) return false;
      if (line.length > 80) return false;
      if (EMAIL_REGEX.test(line) || URL_REGEX.test(line)) return false;
      if (isLikelyLocation(line)) return false;
      if (/^\d+[).:-]?$/.test(line)) return false;
      if (/summary|objective|profile|curriculum|experience/i.test(line)) {
        return false;
      }
      const letters = line.match(/[A-Za-z]/g) || [];
      const digits = line.match(/\d/g) || [];
      if (digits.length > 0) return false;
      return letters.length >= 3;
    });
    return fallback || "Candidate";
  }

  candidates.sort((a, b) => b.score - a.score);
  const [topCandidate] = candidates;
  if (!topCandidate) {
    return "Candidate";
  }

  if (topCandidate.score <= 0) {
    const positive = candidates.find((candidate) => candidate.score > 0);
    if (positive) return positive.value;
    return "Candidate";
  }

  return topCandidate.value;
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

  const fullName = selectFullNameCandidate(nonEmptyLines);

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
    if (/^\d+[).:-]?$/.test(clean)) return;
    const hasLetters = /[A-Za-z]/.test(clean);
    const hasDigits = /\d/.test(clean);
    if (!hasLetters && hasDigits) return;
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

function defaultOutreachKit(targetTitle) {
  const roleLabel = targetTitle ? `${targetTitle} role` : "your next opportunity";
  return {
    elevatorPitch: `I help teams deliver results by combining proven execution with adaptable collaboration for the ${roleLabel}.`,
    subjectLine: `Potential fit for the ${roleLabel}`,
    linkedinMessage:
      `Hi there — I spotted the ${roleLabel} and would love to connect. I blend delivery focus with a people-first approach and can hit the ground running. Happy to share a tailored resume if helpful!`,
    valueHook:
      "Recent highlight: Led cross-functional improvements that boosted efficiency and stakeholder satisfaction.",
  };
}

async function buildOutreachKit({ cvText, jd, targetTitle }) {
  const fallbackBase = defaultOutreachKit(targetTitle);
  const fallback = { ...fallbackBase, __source: "fallback" };
  const client = getOpenAIClient();

  if (!client) return fallback;

  const trimmedCv = cvText.slice(0, 2600);
  const trimmedJd = jd.slice(0, 2000);

  const prompt = [
    "You're crafting a standout outreach kit for a candidate.",
    "Blend credibility with warmth. UK tone. First person.",
    targetTitle
      ? `The target role is: ${targetTitle}.`
      : "No explicit role provided; stay adaptable but confident.",
    "",
    "CV excerpt:",
    `"""${trimmedCv}"""`,
    "",
    "Job description excerpt:",
    `"""${trimmedJd}"""`,
    "",
    "Return an outreach kit that helps the candidate message a hiring manager without repeating long paragraphs.",
  ].join("\n");

  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.45,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "outreach_pack",
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "elevatorPitch",
              "subjectLine",
              "linkedinMessage",
              "valueHook",
            ],
            properties: {
              elevatorPitch: {
                type: "string",
                description:
                  "2-sentence personal pitch weaving in differentiators and the target role.",
              },
              subjectLine: {
                type: "string",
                description: "Concise subject line for an outreach email (max 90 chars).",
                maxLength: 90,
              },
              linkedinMessage: {
                type: "string",
                description: "3-4 sentence LinkedIn message formatted as a single block.",
              },
              valueHook: {
                type: "string",
                description:
                  "One headline achievement or differentiator the candidate should mention.",
              },
            },
          },
        },
      },
    });

    const content = resp.choices?.[0]?.message?.content;
    if (!content) return fallback;

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (parseErr) {
      console.warn("Outreach kit JSON parse failed", parseErr);
      return fallback;
    }

    return {
      ...fallbackBase,
      ...parsed,
      __source: "ai",
    };
  } catch (err) {
    console.warn("Outreach kit generation failed", err);
    return fallback;
  }
}

async function buildImpactHighlights({ cvText, expText, jd, targetTitle }) {
  const fallbackHighlights = fallbackImpactHighlights(expText || cvText || "");
  const fallback = { highlights: fallbackHighlights, __source: "fallback" };
  const client = getOpenAIClient();

  if (!client) return fallback;

  const trimmedExp = (expText || cvText || "").slice(0, 3500);
  const trimmedJd = (jd || "").slice(0, 1800);

  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.35,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "impact_highlights",
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["highlights"],
            properties: {
              highlights: {
                type: "array",
                minItems: 1,
                maxItems: 3,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["headline"],
                  properties: {
                    headline: {
                      type: "string",
                      description:
                        "Short achievement statement written in first person past tense.",
                    },
                    metric: {
                      type: "string",
                      description:
                        "Quantifiable figure or evidence that proves the impact (e.g. 35% uplift).",
                    },
                    proof: {
                      type: "string",
                      description:
                        "One sentence coaching tip on how to frame or expand this story.",
                    },
                  },
                },
              },
            },
          },
        },
      },
      messages: [
        {
          role: "user",
          content: [
            "You create impact snapshots for CVs.",
            targetTitle
              ? `Highlight achievements that support the ${targetTitle} role.`
              : "Highlight achievements that prove seniority and measurable results.",
            "Return 2-3 concise highlights ordered by strength.",
            "Use numbers only when they appear or are strongly implied.",
            "",
            "Candidate experience:",
            `"""${trimmedExp}"""`,
            "",
            "Job description (for context):",
            `"""${trimmedJd}"""`,
          ].join("\n"),
        },
      ],
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) return fallback;

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      console.warn("Impact highlight JSON parse failed", err);
      return fallback;
    }

    const rawHighlights = Array.isArray(parsed.highlights)
      ? parsed.highlights
      : [];
    if (rawHighlights.length === 0) {
      return fallback;
    }

    const sanitised = rawHighlights
      .map((item) => ({
        headline: S(item.headline),
        metric: S(item.metric),
        proof: S(item.proof),
      }))
      .filter((item) => item.headline);

    if (sanitised.length === 0) {
      return fallback;
    }

    return { highlights: sanitised.slice(0, 3), __source: "ai" };
  } catch (err) {
    console.warn("Impact highlight generation failed", err);
    return fallback;
  }
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

function looksLikeBullet(line) {
  return /^[•\-]\s*/.test(line);
}

function splitBulletLine(line) {
  const bulletPrefix = line.match(/^[•\-]\s*/);
  if (bulletPrefix) {
    return [line.replace(bulletPrefix[0], "")];
  }
  return line
    .split("•")
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

function pushSection(children, title, text, { treatBullets = true } = {}) {
  if (!text) return;

  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length === 0) return;

  children.push(label(title));

  blocks.forEach((block) => {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return;

    let firstParagraphPlaced = false;

    lines.forEach((line) => {
      if (!line) return;

      if (treatBullets && (looksLikeBullet(line) || line.includes("•"))) {
        splitBulletLine(line).forEach((item) => {
          if (item) {
            children.push(bullet(item));
          }
        });
        return;
      }

      const paragraphOptions = firstParagraphPlaced
        ? {}
        : { bold: true };

      children.push(
        new Paragraph({
          spacing: { after: 100 },
          alignment: AlignmentType.LEFT,
          children: [createRun(line, paragraphOptions)],
        })
      );

      firstParagraphPlaced = true;
    });
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
    const outreachFallback = {
      ...defaultOutreachKit(targetTitle),
      __source: "fallback",
    };
    const impactFallback = {
      highlights: fallbackImpactHighlights(experienceFallback),
      __source: "fallback",
    };

    const timings = {};
    const [
      summaryResult,
      experienceResult,
      skillsResult,
      outreachResult,
      impactResult,
    ] = await Promise.allSettled([
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
      timedRun({
        key: "outreachMs",
        timeoutLabel: "Outreach kit",
        timeoutMs: 12000,
        task: () => buildOutreachKit({ cvText, jd: jdText, targetTitle }),
        timings,
      }),
      timedRun({
        key: "impactMs",
        timeoutLabel: "Impact highlights",
        timeoutMs: 12000,
        task: () =>
          buildImpactHighlights({
            cvText,
            expText: experienceFallback,
            jd: jdText,
            targetTitle,
          }),
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
    if (outreachResult.status === "rejected") {
      console.warn("Outreach kit AI failed", outreachResult.reason);
    }
    if (impactResult.status === "rejected") {
      console.warn("Impact highlights AI failed", impactResult.reason);
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

    const outreachInternal =
      outreachResult.status === "fulfilled" && outreachResult.value
        ? outreachResult.value
        : outreachFallback;

    const { __source: outreachInternalSource, ...outreachKit } = outreachInternal;

    const outreachSource =
      outreachResult.status === "fulfilled" && outreachInternalSource === "ai"
        ? "ai"
        : "fallback";

    const impactInternal =
      impactResult.status === "fulfilled" && impactResult.value
        ? impactResult.value
        : impactFallback;

    const { __source: impactInternalSource, highlights: impactHighlights } =
      impactInternal;

    const impactSource =
      impactResult.status === "fulfilled" && impactInternalSource === "ai"
        ? "ai"
        : "fallback";

    const roleInsights = deriveKeywordInsights({ cvText, jdText });

    const meta = {
      mode,
      targetTitle: targetTitle || null,
      summarySource: summaryResult.status === "fulfilled" ? "ai" : "fallback",
      experienceSource:
        experienceResult.status === "fulfilled" ? "ai" : "fallback",
      skillsSource: skillsResult.status === "fulfilled" ? "ai" : "fallback",
      outreachSource,
      impactSource,
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
      outreachKit,
      impactHighlights,
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

      children.push(centerHeading(contact.name));

      if (targetTitle) {
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 120 },
            children: [createRun(targetTitle, { italics: true, size: 32 })],
          })
        );
      }

      const contactPara = buildContactParagraph(contact.contactLine);
      if (contactPara) {
        children.push(contactPara);
      }

      children.push(dividerParagraph());

      children.push(label("PROFILE SUMMARY"));
      children.push(para(aiSummary));

      children.push(label("KEY SKILLS"));
      pushSkillLines(children, skillsLine);

      if (roleInsights) {
        children.push(label("ROLE-READY INSIGHTS"));
        if (roleInsights.summary) {
          children.push(
            para(roleInsights.summary, { alignment: AlignmentType.LEFT })
          );
        }
        if (roleInsights.matchedKeywords.length > 0) {
          children.push(
            para(
              `Strengths to spotlight: ${roleInsights.matchedKeywords
                .slice(0, 5)
                .join(", ")}.`,
              { alignment: AlignmentType.LEFT }
            )
          );
        }
        if (roleInsights.missingKeywords.length > 0) {
          children.push(
            para("Consider adding evidence for:", {
              alignment: AlignmentType.LEFT,
            })
          );
          roleInsights.missingKeywords.slice(0, 5).forEach((keyword) => {
            children.push(bullet(keyword));
          });
        }
      }

      if (impactHighlights && impactHighlights.length > 0) {
        children.push(label("IMPACT HIGHLIGHTS"));
        impactHighlights.forEach((highlight) => {
          const metricPrefix = highlight.metric
            ? `${highlight.metric}: `
            : "";
          children.push(
            bullet(`${metricPrefix}${highlight.headline}`.trim())
          );
          if (highlight.proof) {
            children.push(
              para(highlight.proof, { alignment: AlignmentType.LEFT })
            );
          }
        });
      }

      if (outreachKit) {
        children.push(label("OPPORTUNITY OUTREACH PACK"));

        if (outreachKit.elevatorPitch) {
          children.push(
            para(`Elevator pitch: ${outreachKit.elevatorPitch}`, {
              alignment: AlignmentType.LEFT,
            })
          );
        }
        if (outreachKit.valueHook) {
          children.push(
            para(`Value hook: ${outreachKit.valueHook}`, {
              alignment: AlignmentType.LEFT,
            })
          );
        }
        if (outreachKit.subjectLine) {
          children.push(
            para(`Email subject: ${outreachKit.subjectLine}`, {
              alignment: AlignmentType.LEFT,
            })
          );
        }
        if (outreachKit.linkedinMessage) {
          const linkedInLines = outreachKit.linkedinMessage
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean);
          if (linkedInLines.length > 0) {
            children.push(
              para("LinkedIn message:", { alignment: AlignmentType.LEFT })
            );
            linkedInLines.forEach((line) =>
              children.push(para(line, { alignment: AlignmentType.LEFT }))
            );
          }
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
        styles: {
          default: {
            paragraph: {
              spacing: { after: 120 },
            },
            run: {
              font: BODY_FONT,
              size: BODY_SIZE,
              color: HEADING_COLOR,
            },
          },
        },
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

      payload.outreachKit = outreachKit;
      payload.impactHighlights = impactHighlights;
      payload.impactHighlightsSource = impactSource;

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
