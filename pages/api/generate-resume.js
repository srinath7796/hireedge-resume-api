// pages/api/generate-resume.js
// HireEdge – JSON-only CV → JD aligned → DOCX output

import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import OpenAI from "openai";

// your framer domain
const ALLOWED_ORIGIN = "https://hireedge.co.uk";

// small helper
const S = (v) => (v ?? "").toString().trim();

// we only accept JSON now, so leave bodyParser ON (default)
// if you ever re-add multipart, change this.
export const config = {
  api: {
    bodyParser: true,
  },
};

// ----- OpenAI client -----
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ----- docx helpers -----
const centerHeading = (txt, size = 32, bold = true) =>
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
    children: [new TextRun({ text: txt, bold, size })],
  });

const centerLine = (txt) =>
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 150 },
    children: [new TextRun(txt)],
  });

const label = (txt) =>
  new Paragraph({
    spacing: { before: 240, after: 100 },
    children: [new TextRun({ text: txt, bold: true })],
  });

const para = (txt) => new Paragraph({ children: [new TextRun(txt)] });
const bullet = (txt) => new Paragraph({ text: txt, bullet: { level: 0 } });

// ----- very simple CV text splitter -----
function parsePastedCv(raw = "") {
  const txt = raw.replace(/\r/g, "\n");
  const lines = txt
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // name: first non-empty line, if it looks like a name
  const fullName = lines[0] || "Candidate";

  // contact: second line or any line with @ or phone
  let contactLine = "";
  for (let i = 1; i < Math.min(lines.length, 6); i++) {
    if (
      lines[i].includes("@") ||
      /\d{5,}/.test(lines[i]) ||
      lines[i].toLowerCase().includes("london") ||
      lines[i].toLowerCase().includes("united kingdom")
    ) {
      contactLine = lines[i];
      break;
    }
  }

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

// ----- AI helpers (all trimmed so we don’t blow context) -----
async function rewriteSummary({ currentSummary, jd, targetTitle }) {
  const client = getOpenAIClient();
  const safeSummary =
    currentSummary && currentSummary.length
      ? currentSummary.slice(0, 900)
      : "Motivated professional with transferable experience.";

  const safeJd = (jd || "").slice(0, 1500);

  if (!client) {
    return `${safeSummary} Aligned to the role: ${targetTitle || "target position"}.`;
  }

  const prompt = `
You are a UK CV writer.

Rewrite the candidate summary so it:
- stays true to the candidate
- is 3–4 sentences
- matches the job description
- highlights sales / customer / stakeholder strengths if present
- is ATS-friendly
- no fake achievements

Candidate summary:
"""${safeSummary}"""

Job description:
"""${safeJd}"""

Return ONLY the rewritten summary.
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
  const safeExp = (expText || "").slice(0, 2500);
  const safeJd = (jd || "").slice(0, 1500);

  if (!client) {
    // fallback: just return pasted exp
    return safeExp;
  }

  const prompt = `
You get a candidate's pasted EXPERIENCE section.

Rewrite it in UK CV style with headings + bullets.
Keep the same jobs (do NOT invent companies).
Make bullets relevant to this job description.

Experience pasted:
"""${safeExp}"""

Job description:
"""${safeJd}"""

Output format:

Job Title | Company – Location
MM/YYYY – MM/YYYY
• bullet
• bullet
• bullet
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
  const safeCv = (cvText || "").slice(0, 2000);
  const safeJd = (jd || "").slice(0, 1000);

  if (!client) {
    return "Customer Service • Sales • Stakeholder Management • Communication • Time Management";
  }

  const prompt = `
From the candidate CV and JD, produce ONE line of 10–14 skills, separated by " • ".
Keep only plausible skills for the candidate.

CV:
"""${safeCv}"""

JD:
"""${safeJd}"""
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.25,
  });

  return resp.choices[0].message.content.trim();
}

// ----- main handler -----
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "HireEdge resume API alive ✅" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // we expect JSON
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    // IMPORTANT: these names match frontend
    const cvText = S(body.cvText || body.oldCvText || body.pastedCv);
    const jdText = S(body.jobDescription || body.jd);
    const email = S(body.email);

    if (!cvText) {
      return res.status(400).json({ error: "No CV text found" });
    }

    // parse pasted CV
    const parsed = parsePastedCv(cvText);

    // AI bits
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

    // education: keep user’s if we saw one
    const eduBlock =
      parsed.eduText ||
      "Education details available on request.";

    // ----- build DOCX -----
    const children = [];

    // name
    children.push(centerHeading(parsed.fullName || "Candidate", 40, true));

    // contact: let’s combine with email if we have it
    const contactBits = [];
    if (parsed.contactLine) contactBits.push(parsed.contactLine);
    if (email) contactBits.push(email);
    if (contactBits.length) {
      children.push(centerLine(contactBits.join(" | ")));
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
