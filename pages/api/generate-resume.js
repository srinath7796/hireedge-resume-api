// pages/api/generate-resume.js
// HireEdge – CV generator (paste OR upload)

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

let mammoth; // lazy for .docx
let pdfParse; // lazy for .pdf

const ALLOWED_ORIGIN = "https://hireedge.co.uk";
const S = (v) => (v ?? "").toString().trim();

export const config = {
  api: {
    bodyParser: false, // we allow multipart, so we must parse JSON ourselves
  },
};

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

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

// very simple parser
function parsePastedCv(raw = "") {
  const txt = raw.replace(/\r/g, "\n");
  const lines = txt.split("\n").map((l) => l.trim());

  const fullName = lines[0] || "Candidate";
  const contactLine = lines[1] || "";

  const summaryMatch = txt.match(/summary\s*\n([\s\S]*?)(experience|education|skills)/i);
  const summaryText = summaryMatch ? summaryMatch[1].trim() : "";

  const expMatch = txt.match(/experience\s*\n([\s\S]*?)(education|skills|profile|certifications|$)/i);
  const expText = expMatch ? expMatch[1].trim() : "";

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

async function readUploadedFile(file) {
  const ext = path.extname(file.originalFilename || "").toLowerCase();

  if (ext === ".docx") {
    if (!mammoth) {
      mammoth = (await import("mammoth")).default;
    }
    const result = await mammoth.extractRawText({ path: file.filepath });
    return result.value || "";
  }

  if (ext === ".pdf") {
    if (!pdfParse) {
      pdfParse = (await import("pdf-parse")).default;
    }
    const buffer = fs.readFileSync(file.filepath);
    const data = await pdfParse(buffer);
    return data.text || "";
  }

  return fs.readFileSync(file.filepath, "utf8");
}

async function rewriteSummary({ currentSummary, jd, targetTitle }) {
  const client = getOpenAIClient();
  if (!client) {
    return (
      currentSummary ||
      `Motivated professional aligned to ${targetTitle || "the target role"}.`
    );
  }

  const prompt = `
You are a UK CV writer.

Rewrite the following candidate summary so that:
- it stays TRUE to the candidate
- it reflects the job description below
- it is 3–4 sentences
- it is ATS-friendly
- tone: professional

Candidate summary:
"""${currentSummary}"""

Job description:
"""${jd}"""

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
  if (!client) {
    return expText;
  }

  const prompt = `
You will receive a candidate's EXPERIENCE SECTION exactly as they pasted it.

Your task:
1. Keep their real jobs (titles, companies, dates).
2. For each role, write 3–5 bullets, aligned to the job description.
3. Do NOT invent employers or dates.

Candidate experience:
"""${expText}"""

Job description:
"""${jd}"""

Return ONLY the structured experience.
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
  if (!client) {
    return "Stakeholder Management • Sales • Reporting • Customer Service";
  }

  const prompt = `
From the candidate CV and the job description, produce 10–14 skills separated by " • ".
Keep candidate skills, add JD skills only if transferable.

CV:
"""${cvText}"""

JD:
"""${jd}"""
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
  });

  return resp.choices[0].message.content.trim();
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

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

    if (contentType.includes("multipart/form-data")) {
      // ---------- UPLOAD BRANCH ----------
      const form = formidable({ multiples: false, keepExtensions: true });
      const { fields, files } = await new Promise((resolve, reject) => {
        form.parse(req, (err, fields, files) => {
          if (err) reject(err);
          else resolve({ fields, files });
        });
      });

      // file is optional now – user may send only text
      const file = files.cv || files.file || files.cvFile;
      if (file) {
        cvText = await readUploadedFile(file);
      } else {
        // 👇 NEW: allow CV text in multipart too
        cvText = S(fields.cvText || fields.oldCvText || fields.pastedCv);
      }

      jdText = S(fields.jobDescription || fields.jd);
      userEmail = S(fields.email || fields.userEmail);
    } else {
      // ---------- JSON BRANCH ----------
      // 👇 NEW: manually read raw body because bodyParser is false
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const body = rawBody ? JSON.parse(rawBody) : {};

      cvText = S(body.cvText || body.oldCvText || body.pastedCv);
      jdText = S(body.jobDescription || body.jd);
      userEmail = S(body.email);
    }

    if (!cvText) {
      return res.status(400).json({ error: "No CV text found" });
    }

    // 1) parse
    const parsed = parsePastedCv(cvText);

    // 2) ai bits
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

    const eduBlock =
      parsed.eduText ||
      "Education details available on request.";

    // ---------- BUILD DOCX ----------
    const children = [];

    children.push(centerHeading(parsed.fullName || "Candidate", 40, true));

    if (parsed.contactLine) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [new TextRun(parsed.contactLine)],
        })
      );
    }

    children.push(label("PROFILE SUMMARY"));
    children.push(para(aiSummary));

    children.push(label("KEY SKILLS"));
    children.push(para(skillsLine));

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
    return res
      .status(500)
      .json({ error: "AI resume generation failed", details: String(err) });
  }
}
