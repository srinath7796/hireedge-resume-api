// pages/api/generate-resume.js
// HireEdge – CV generator (paste OR upload) – cleaned output, proper bullets, JD alignment

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

let mammoth;   // lazy for .docx
let pdfParse;  // lazy for .pdf

const ALLOWED_ORIGIN = "https://hireedge.co.uk";
const S = (v) => (v ?? "").toString().trim();

export const config = {
  api: {
    bodyParser: false,
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

// quick-and-dirty CV splitter
function parsePastedCv(raw = "") {
  const txt = raw.replace(/\r/g, "\n");
  const lines = txt.split("\n").map((l) => l.trim()).filter(Boolean);

  const fullName = lines[0] || "Candidate";
  const contactLine = lines[1] || "";

  const summaryMatch = txt.match(/summary\s*\n([\s\S]*?)(experience|education|skills)/i);
  const summaryText = summaryMatch ? summaryMatch[1].trim() : "";

  const expMatch = txt.match(/experience\s*\n([\s\S]*?)(education|skills|profile|certifications|$)/i);
  const expText = expMatch ? expMatch[1].trim() : "";

  const eduMatch = txt.match(/education\s*\n([\s\S]*?)$/i);
  const eduText = eduMatch ? eduMatch[1].trim() : "";

  return { fullName, contactLine, summaryText, expText, eduText };
}

// upload parsers
async function readUploadedFile(file) {
  const ext = path.extname(file.originalFilename || "").toLowerCase();

  if (ext === ".docx") {
    if (!mammoth) mammoth = (await import("mammoth")).default;
    const result = await mammoth.extractRawText({ path: file.filepath });
    return result.value || "";
  }

  if (ext === ".pdf") {
    if (!pdfParse) pdfParse = (await import("pdf-parse")).default;
    const buffer = fs.readFileSync(file.filepath);
    const data = await pdfParse(buffer);
    return data.text || "";
  }

  return fs.readFileSync(file.filepath, "utf8");
}

// remove ```markdown, ``` and leading helper sentences
function cleanLLMText(txt = "") {
  let t = txt.replace(/```[\s\S]*?```/g, "");    // remove fenced code
  t = t.replace(/```markdown/gi, "");
  t = t.replace(/```/g, "");
  // kill prefixes like "Based on the candidate..."
  t = t.replace(/based on the candidate.*?\n/i, "");
  t = t.replace(/here are the transferable skills:?/i, "");
  return t.trim();
}

// turn the LLM “experience” text into paragraphs + bullets
function normaliseExperienceToDocx(expText = "") {
  const lines = expText.split("\n").map((l) => l.trim()).filter(Boolean);
  const nodes = [];
  lines.forEach((line) => {
    if (/^[-•]/.test(line)) {
      nodes.push(bullet(line.replace(/^[-•]\s?/, "")));
    } else {
      nodes.push(para(line));
    }
  });
  return nodes;
}

// shrink education to CV-style lines
function compressEducation(eduRaw = "") {
  const lines = eduRaw.split("\n").map((l) => l.trim()).filter(Boolean);
  // keep first 4 lines max
  return lines.slice(0, 6);
}

// ---------- AI prompts ----------
async function rewriteSummary({ currentSummary, jd, targetTitle }) {
  const client = getOpenAIClient();
  if (!client) {
    return (
      currentSummary ||
      `Motivated professional aligned to the role.`
    );
  }

  const prompt = `
You are a UK CV writer.

Rewrite the candidate summary so it:
- stays TRUE to the candidate
- clearly shows fit for this job description (sales, performance-driven, relationship building, residential / construction clients)
- is 3–4 sentences
- is ATS-friendly
- no meta text

Candidate summary:
"""${currentSummary}"""

Job description:
"""${jd}"""

Return only the summary.
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
  if (!client) return expText;

  const prompt = `
You will improve the candidate's EXPERIENCE section for a SALES / BUSINESS DEVELOPMENT role.

Rules:
1. KEEP all real jobs, titles, companies and dates from the candidate.
2. For each job, write 3–5 bullets that are believable for that job.
3. Make bullets show: relationship building, target-driven work, pipeline / reporting, dealing with homeowners/developers/contractors, presenting solutions.
4. Align language to this job description:
"""${jd}"""
5. DO NOT add code fences, DO NOT say "here is".
6. Output as plain text like:

Job Title | Company – Location
MM/YYYY – MM/YYYY
• bullet
• bullet

Candidate experience:
"""${expText}"""
  `;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.45,
  });

  return resp.choices[0].message.content.trim();
}

async function buildSkills({ cvText, jd }) {
  const client = getOpenAIClient();
  if (!client) {
    return "Sales Strategy • Client Relationship Management • Pipeline Management • Customer Service • Stakeholder Liaison • Negotiation • Reporting";
  }

  const prompt = `
Create ONE line of 10–14 skills separated by " • ".
Prioritise skills that appear in either the CV or this JD (sales, performance-based, relationship building, construction/residential clients).

CV:
"""${cvText}"""

JD:
"""${jd}"""

Return ONLY the skill line.
  `;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.25,
  });

  return resp.choices[0].message.content.trim();
}

// ---------- handler ----------
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

    if (contentType.includes("multipart/form-data")) {
      // upload flow
      const form = formidable({ multiples: false, keepExtensions: true });
      const { fields, files } = await new Promise((resolve, reject) => {
        form.parse(req, (err, fields, files) => {
          if (err) reject(err);
          else resolve({ fields, files });
        });
      });

      const file = files.cv || files.cvFile || files.file;
      if (!file) return res.status(400).json({ error: "No file uploaded" });

      cvText = await readUploadedFile(file);
      jdText = S(fields.jobDescription || fields.jd);
      userEmail = S(fields.email || fields.userEmail);
    } else {
      // paste flow
      const body =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      cvText = S(body.cvText || body.oldCvText || body.pastedCv);
      jdText = S(body.jobDescription || body.jd);
      userEmail = S(body.email);
    }

    if (!cvText) {
      return res.status(400).json({ error: "No CV text found" });
    }

    // 1. parse
    const parsed = parsePastedCv(cvText);

    // 2. AI parts
    const aiSummary = await rewriteSummary({
      currentSummary: parsed.summaryText || cvText.slice(0, 500),
      jd: jdText,
      targetTitle: "",
    });

    const alignedExperienceRaw = await alignExperience({
      expText: parsed.expText || cvText,
      jd: jdText,
    });

    const alignedExperience = cleanLLMText(alignedExperienceRaw);
    const skillsLine = cleanLLMText(await buildSkills({ cvText, jd: jdText }));

    // 3. education tidy
    const eduLines = compressEducation(
      parsed.eduText ||
        "MSc Data Science – University of Roehampton, London (2024)\nMBA – ICFAI Business School, Bangalore (2019)\nBE Mechanical Engineering – Nandha College of Technology, Erode (2017)"
    );

    // 4. build docx
    const children = [];

    // name + contact
    children.push(centerHeading(parsed.fullName || "Candidate", 40));
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
    const expNodes = normaliseExperienceToDocx(alignedExperience);
    children.push(...expNodes);

    // education
    children.push(label("EDUCATION"));
    eduLines.forEach((l) => children.push(para(l)));

    // doc
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
      `attachment; filename="${encodeURIComponent("HireEdge_CV.docx")}"`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    return res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error("generate-resume error:", err);
    return res
      .status(500)
      .json({ error: "AI resume generation failed", details: String(err) });
  }
}
