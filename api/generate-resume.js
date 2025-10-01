// api/generate-resume.js
// Vercel Serverless Function — generates a tailored DOCX résumé

import OpenAI from "openai";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import fs from "fs";
import path from "path";

// ---------------- CORS ----------------
function applyCors(req, res) {
  const origin = req.headers.origin || "";
  // Add any storefront/admin origins you actually use:
  const allowed = new Set([
    "https://hireedge.co.uk",
    "https://www.hireedge.co.uk",
    "https://hireedge.myshopify.com"
  ]);

  if (origin && allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  // If you want to test from anywhere temporarily, uncomment:
  // res.setHeader("Access-Control-Allow-Origin", "*");

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400"); // cache preflight
}

// ---------------- OpenAI ----------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function buildPrompt({ jd, profile }) {
  return `
You are an expert UK CV writer. Tailor the candidate’s CV to the job description.

Return STRICT JSON with these keys ONLY:
- summary: string (3–4 lines, UK tone)
- skills: array of 8–12 ATS keywords from the JD
- experience_blocks: array of roles, each object:
  { "title": string, "company": string, "location": string, "start": string, "end": string, "bullets": array of 3-6 strings }
- education: array of { "degree": string, "institution": string, "year": string }

DO NOT include commentary or extra keys.

JOB DESCRIPTION:
${jd}

CANDIDATE PROFILE:
${JSON.stringify(profile, null, 2)}
`;
}

// retry once on transient 429s
async function askOpenAI(prompt) {
  const opts = {
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You write ATS-optimised UK CVs using clear, concise language." },
      { role: "user", content: prompt }
    ],
    temperature: 0.3
  };
  try {
    return await openai.chat.completions.create(opts);
  } catch (e) {
    if (e?.status === 429 || String(e).toLowerCase().includes("rate")) {
      await new Promise(r => setTimeout(r, 1200));
      return await openai.chat.completions.create(opts);
    }
    throw e;
  }
}

// ---------------- Handler ----------------
export default async function handler(req, res) {
  applyCors(req, res);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    // Body can be parsed already (Vercel) or be a raw string
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { /* ignore */ }
    }

    const { jd, profile } = body || {};
    if (!jd || !profile?.fullName) {
      return res.status(400).json({ error: "Missing jd or profile.fullName" });
    }

    // (Optional) trim overly long JDs to keep tokens in check
    const trimmedJD = String(jd).slice(0, 12000);

    // 1) Get structured content from OpenAI
    const prompt = buildPrompt({ jd: trimmedJD, profile });
    const completion = await askOpenAI(prompt);

    const raw = completion?.choices?.[0]?.message?.content || "{}";
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(502).json({
        error: "Model output was not valid JSON",
        details: raw?.slice(0, 400)
      });
    }

    // 2) Map JSON into template fields (safe)
    const safeArr = v => (Array.isArray(v) ? v : []);
    const safeStr = v => (typeof v === "string" ? v : "");

    const expBlocks = safeArr(data.experience_blocks).map(r => {
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
      const dates = (start || end) ? ` (${start || "Start"}–${end || "Present"})` : "";
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
        .map(e => `${safeStr(e?.degree)}, ${safeStr(e?.institution)} (${safeStr(e?.year)})`)
        .join("\n")
    };

    // 3) Load and fill the DOCX template
    // If your template is in /templates, change to:
    // const templatePath = path.join(process.cwd(), "templates", "uk_modern_cv_template.docx");
    const templatePath = path.join(process.cwd(), "uk_modern_cv_template.docx");

    const content = fs.readFileSync(templatePath, "binary");
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

    doc.setData(mapped);
    doc.render();
    const buf = doc.getZip().generate({ type: "nodebuffer" });

    // 4) Send file
    const role = (mapped.JOB_TITLE || "CV").replace(/[^a-z0-9]+/gi, "_");
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="HireEdge_${role}.docx"`
    );
    return res.status(200).send(buf);

  } catch (err) {
    const msg = err?.response?.data || err?.message || String(err);
    console.error("ERROR:", msg);

    if (String(msg).includes("You exceeded your current quota")) {
      return res.status(429).json({ error: "OpenAI quota exceeded. Please check billing/limits." });
    }
    if (String(msg).includes("ENOENT")) {
      return res.status(500).json({ error: "Template file not found. Check templatePath or file location." });
    }
    return res.status(500).json({ error: "Resume generation failed", details: msg });
  }
}
