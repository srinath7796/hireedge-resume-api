// api/generate-resume.js
// Vercel Serverless Function (ESM). Generates a tailored DOCX CV from a template.

import OpenAI from "openai";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import fs from "fs";
import path from "path";

// ----------------------
// 0) CONFIG
// ----------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Allow CORS only from your shop domains (add/remove as needed)
const ALLOWED_ORIGINS = new Set([
  "https://hireedge.co.uk",
  "https://www.hireedge.co.uk",
  // Optional: your preview domain if you test from Customize / editor
  "https://197gtv-0q.myshopify.com",
]);

// Try these template paths in order (first one that exists is used)
const TEMPLATE_CANDIDATES = [
  path.join(process.cwd(), "uk_modern_cv_template.docx"),
  path.join(process.cwd(), "templates", "uk_modern_cv_template.docx"),
];

// OpenAI model
const MODEL = "gpt-4o-mini";

// ----------------------
// 1) Helpers
// ----------------------
function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sanitizeFilenamePart(v) {
  return (v || "CV").toString().trim().replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
}

function pickTemplatePath() {
  for (const p of TEMPLATE_CANDIDATES) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return p;
    } catch (_) {}
  }
  return null;
}

function buildPrompt({ jd, profile }) {
  // profile.previousRoles is expected to be an array of:
  // { title, company, location, start, end, bullets: [string, ...] }
  // We pass it as primary source of experience for the model to rewrite/align.
  const meta = {
    fullName: profile.fullName,
    targetTitle: profile.targetTitle,
    email: profile.email,
    phone: profile.phone,
    linkedin: profile.linkedin,
    yearsExp: profile.yearsExp,
    topSkills: profile.topSkills,
  };

  return `
You are an expert UK CV writer. Use the candidate’s provided roles as the primary source of experience. Improve clarity, quantify impact, and align to the job description. Do not invent employers or dates. Keep UK tone and spelling. Keep all output strictly factual.

Return STRICT JSON with these keys ONLY:
- summary: string (3–4 lines, UK tone)
- skills: array of 8–12 ATS keywords taken from the JD
- experience_blocks: array of roles, each object EXACTLY with keys:
  { "title": string, "company": string, "location": string, "start": string, "end": string, "bullets": array of 3-6 strings }
- education: array of { "degree": string, "institution": string, "year": string }

JOB DESCRIPTION:
${jd}

CANDIDATE META:
${JSON.stringify(meta, null, 2)}

CANDIDATE PREVIOUS ROLES (base your experience blocks on these, improve the bullets but keep them truthful):
${JSON.stringify(profile.previousRoles || [], null, 2)}
`;
}

async function askOpenAI(prompt) {
  try {
    return await openai.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            "You write ATS-optimised UK CVs using clear, concise language. Output must be valid JSON that matches the requested schema.",
        },
        { role: "user", content: prompt },
      ],
    });
  } catch (e) {
    // Retry once on 429 / rate limit
    const msg = (e && (e.message || e.toString())) || "";
    if (e?.status === 429 || /rate/i.test(msg)) {
      await new Promise((r) => setTimeout(r, 1200));
      return await openai.chat.completions.create({
        model: MODEL,
        response_format: { type: "json_object" },
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "You write ATS-optimised UK CVs using clear, concise language. Output must be valid JSON that matches the requested schema.",
          },
          { role: "user", content: prompt },
        ],
      });
    }
    throw e;
  }
}

function safeArr(v) {
  return Array.isArray(v) ? v : [];
}
function safeStr(v) {
  return typeof v === "string" ? v : "";
}

// ----------------------
// 2) Handler
// ----------------------
export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    // Body might be object (Vercel JSON) or string (fallback)
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ error: "Invalid JSON body" });
      }
    }

    const { jd, profile } = body || {};
    if (!jd || !profile?.fullName) {
      return res.status(400).json({ error: "Missing jd or profile.fullName" });
    }

    // 1) Ask model for structured CV content
    const prompt = buildPrompt({ jd, profile });
    const completion = await askOpenAI(prompt);
    const raw = completion?.choices?.[0]?.message?.content || "{}";

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(502).json({
        error: "Model output was not valid JSON",
        details: raw?.slice(0, 500),
      });
    }

    // 2) Map JSON to template placeholders
    const expBlocks = safeArr(data.experience_blocks).map((r) => {
      const title = safeStr(r?.title);
      const company = safeStr(r?.company);
      const location = safeStr(r?.location);
      const start = safeStr(r?.start);
      const end = safeStr(r?.end);
      const bullets = safeArr(r?.bullets);
      const bulletsText = bullets.length ? `\n- ${bullets.join("\n- ")}` : "";
      const header = [title, "—", company, location ? `, ${location}` : ""]
        .filter(Boolean)
        .join(" ");
      const dates =
        start || end ? ` (${start || "Start"}–${end || "Present"})` : "";
      return `\n${header}${dates}${bulletsText}`;
    });

    const mapped = {
      FULL_NAME: safeStr(profile.fullName),
      JOB_TITLE: safeStr(profile.targetTitle),
      EMAIL: safeStr(profile.email),
      PHONE: safeStr(profile.phone),
      LINKEDIN: safeStr(profile.linkedin),
      SUMMARY: safeStr(data.summary),
      SKILLS: safeArr(data.skills).join(" • "),
      EXPERIENCE_BLOCKS: expBlocks.join("\n\n"),
      EDUCATION: safeArr(data.education)
        .map(
          (e) =>
            `${safeStr(e?.degree)}, ${safeStr(e?.institution)} (${safeStr(e?.year)})`
        )
        .join("\n"),
    };

    // 3) Load DOCX template
    const templatePath = pickTemplatePath();
    if (!templatePath) {
      return res
        .status(500)
        .json({ error: "Template file not found in project." });
    }

    const content = fs.readFileSync(templatePath, "binary");
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

    // 4) Fill & render
    doc.setData(mapped);
    try {
      doc.render();
    } catch (e) {
      // Docxtemplater formatting errors (e.g., bad tags) are caught here
      return res.status(500).json({
        error: "Template rendering failed",
        details: e?.message || String(e),
      });
    }

    const buf = doc.getZip().generate({ type: "nodebuffer" });

    // 5) Send as file
    const role = sanitizeFilenamePart(mapped.JOB_TITLE || "CV");
    const filename = `HireEdge_${role}.docx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    // RFC 5987 filename* for UTF-8 safety
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(
        filename
      )}`
    );
    return res.status(200).send(buf);
  } catch (err) {
    const msg =
      err?.response?.data || err?.message || err?.toString?.() || "Unknown error";
    console.error("ERROR:", msg);

    if (String(msg).includes("You exceeded your current quota")) {
      return res
        .status(429)
        .json({ error: "OpenAI quota exceeded. Please check billing/limits." });
    }
    if (String(msg).includes("ENOENT")) {
      return res
        .status(500)
        .json({ error: "Template file not found. Check template path." });
    }
    return res.status(500).json({ error: "Resume generation failed", details: msg });
  }
}
