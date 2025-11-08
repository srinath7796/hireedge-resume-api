// pages/api/generate-resume.js
// HireEdge — AI CV Generator (JSON + multipart upload)

import { IncomingForm } from "formidable";
import fs from "fs/promises";
import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import OpenAI from "openai";

// 👇 important for formidable (multipart)
export const config = {
  api: {
    bodyParser: false,
  },
};

const ALLOWED_ORIGIN = "https://hireedge.co.uk"; // change if you serve from another domain
const S = (v) => (v ?? "").toString().trim();

/* ----------------------------------------------------
   1. OPENAI CLIENT
---------------------------------------------------- */
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/* ----------------------------------------------------
   2. DOCX HELPERS
---------------------------------------------------- */
const label = (txt) =>
  new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text: txt, bold: true })],
  });

const para = (txt) => new Paragraph({ children: [new TextRun(txt)] });

const bullet = (txt) => new Paragraph({ text: txt, bullet: { level: 0 } });

/* ----------------------------------------------------
   3. JD KEYWORD EXTRACTOR
---------------------------------------------------- */
function extractKeywordsFromJD(jd = "", limit = 10) {
  if (!jd) return [];
  const text = jd.toLowerCase();
  const words = text.split(/[^a-z0-9+]+/).filter(Boolean);

  const bad = new Set([
    "and",
    "the",
    "for",
    "with",
    "your",
    "you",
    "our",
    "their",
    "will",
    "able",
    "work",
    "role",
    "team",
    "looking",
    "join",
    "growing",
    "environment",
    "experience",
    "service",
    "customer",
    "support",
    "provide",
    "required",
    "essential",
    "previous",
    "contact",
    "centre",
    "center",
    "must",
    "job",
    "description",
  ]);

  const counts = {};
  for (const w of words) {
    if (bad.has(w)) continue;
    if (w.length < 4) continue;
    counts[w] = (counts[w] || 0) + 1;
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)
    .slice(0, limit);
}

/* ----------------------------------------------------
   4. PARSE "PASTED CV" INTO EXPERIENCE / EDUCATION
   (this is your old smart parser, kept as-is)
---------------------------------------------------- */
function parseOldCvSmart(raw = "") {
  const text = raw.replace(/\r/g, "\n");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const experiences = [];
  const education = [];

  const dateHeaderRe =
    /^(\d{2}\/\d{4})\s+(to|-)\s+(Present|\d{2}\/\d{4})/i;
  const eduDateRe = /^(\d{2}\/\d{4})\s+/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (dateHeaderRe.test(line)) {
      const m = line.match(dateHeaderRe);
      const start = m[1];
      const end = m[3];
      const title = lines[i + 1] || "";
      const company = lines[i + 2] || "";
      const bulletsArr = [];
      let j = i + 3;
      while (j < lines.length && lines[j].startsWith("•")) {
        bulletsArr.push(lines[j].replace(/^•\s?/, "").trim());
        j++;
      }
      experiences.push({
        title: S(title),
        company: S(company),
        location: "",
        start,
        end,
        bullets: bulletsArr,
      });
      i = j;
      continue;
    }

    if (eduDateRe.test(line)) {
      const m = line.match(eduDateRe);
      const year = m[1].slice(3);
      const degree = line.replace(eduDateRe, "").trim();
      const institution = lines[i + 1] || "";
      education.push({
        degree: S(degree),
        institution: S(institution),
        year: S(year),
      });
      i = i + 2;
      continue;
    }

    i++;
  }

  return { experiences, education };
}

/* ----------------------------------------------------
   5. AI HELPERS
---------------------------------------------------- */
async function buildSummary({ profile, jd, sourceSummary, jdKeywords = [] }) {
  const client = getOpenAIClient();
  if (!client) {
    return (
      sourceSummary ||
      `Experienced ${profile.targetTitle || "professional"} aligned to the provided job description.`
    );
  }

  const prompt = `
You are a UK CV writer.
Rewrite this PROFILE SUMMARY so it is 3–4 sentences, ATS-friendly, and aligned to the job description.
Include some of these keywords if natural: ${jdKeywords.join(", ")}
Do NOT invent achievements.

Candidate:
- Name: ${profile.fullName || "Candidate"}
- Target: ${profile.targetTitle || "role"}

Existing summary:
"""${sourceSummary || ""}"""

Job description:
"""${jd}"""

Return only the final summary.
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.35,
  });

  return resp.choices[0].message.content.trim();
}

async function buildBulletsForRole({ role, jd, profile, jdKeywords = [] }) {
  const client = getOpenAIClient();
  if (!client) {
    return [
      "Maintained strong stakeholder relationships.",
      "Supported business operations in a fast-paced setting.",
    ];
  }

  const prompt = `
Write 4 UK CV bullet points for this role, aligned to the JD.
Use natural ATS language.
Keywords (use only when natural): ${jdKeywords.join(", ")}

Role: ${role.title || "role"}
Job description:
"""${jd}"""
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.5,
  });

  return resp.choices[0].message.content
    .split("\n")
    .map((l) => l.replace(/^[-•]\s?/, "").trim())
    .filter(Boolean)
    .slice(0, 4);
}

async function enhanceExistingBullets({ bullets, role, jd, jdKeywords = [] }) {
  const client = getOpenAIClient();
  if (!client) return bullets;

  const prompt = `
Rewrite these CV bullets so they are ATS-friendly and aligned to the job description.
Keep the meaning.
Include some of these keywords if they fit: ${jdKeywords.join(", ")}

Job description:
"""${jd}"""

Bullets:
${bullets.map((b) => "- " + b).join("\n")}

Return only the rewritten bullets, one per line.
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.45,
  });

  const rewritten = resp.choices[0].message.content
    .split("\n")
    .map((l) => l.replace(/^[-•]\s?/, "").trim())
    .filter(Boolean);

  return rewritten.length ? rewritten : bullets;
}

/* ----------------------------------------------------
   6. UNIVERSAL REQUEST PARSER
   - if JSON → parse JSON (Paste CV)
   - if multipart → parse form + file (Upload CV)
---------------------------------------------------- */
async function parseRequest(req) {
  const contentType = req.headers["content-type"] || "";
  const isMultipart = contentType.includes("multipart/form-data");

  if (!isMultipart) {
    // JSON mode
    let body = "";
    await new Promise((resolve) => {
      req.on("data", (chunk) => (body += chunk));
      req.on("end", resolve);
    });
    const json = body ? JSON.parse(body) : {};
    return { ...json, _source: "json" };
  }

  // multipart mode
  return await new Promise((resolve, reject) => {
    const form = new IncomingForm({ keepExtensions: true });
    form.parse(req, async (err, fields, files) => {
      if (err) return reject(err);

      // fields from Framer embed
      const jd = fields.jobDescription?.[0] || fields.jd?.[0] || "";
      const email = fields.email?.[0] || "";

      // file — we can't easily read docx/pdf as text without extra libs,
      // so we'll just keep filename as a hint
      const cvFile = files.cv?.[0] || files["cvFile"]?.[0];

      resolve({
        mode: "cv",
        jd,
        email,
        oldCvText:
          cvFile?.originalFilename
            ? `Candidate CV: ${cvFile.originalFilename}`
            : "",
        _source: "multipart",
      });
    });
  });
}

/* ----------------------------------------------------
   7. MAIN HANDLER
---------------------------------------------------- */
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "HireEdge AI Resume API alive ✅",
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // 👇 this is the big change: handles JSON + multipart
    const body = await parseRequest(req);

    const mode = body.mode === "cv" ? "cv" : "manual";
    const jd = S(body.jd || body.jobDescription);
    const jdKeywords = extractKeywordsFromJD(jd, 10);

    // profile
    const profile = {
      fullName: S(body.fullName || body?.profile?.fullName),
      targetTitle: S(body.targetTitle || body?.profile?.targetTitle),
      email: S(body.email || body?.profile?.email),
      phone: S(body.phone || body?.profile?.phone),
      linkedin: S(body.linkedin || body?.profile?.linkedin),
      topSkills: S(body.topSkills || body?.profile?.topSkills),
    };

    let experiences = [];
    let education = [];

    if (mode === "manual") {
      // pasted structured JSON (your lower panel)
      experiences = Array.isArray(body.experiences || body.experience)
        ? body.experiences || body.experience
        : [];
      experiences = experiences.map((r) => ({
        title: S(r.title),
        company: S(r.company),
        location: S(r.location),
        start: S(r.start),
        end: S(r.end),
        bullets: Array.isArray(r.bullets)
          ? r.bullets.map(S).filter(Boolean)
          : S(r.bullets)
              .split("\n")
              .map((t) => t.trim())
              .filter(Boolean),
      }));
      education = Array.isArray(body.education)
        ? body.education.map((e) => ({
            degree: S(e.degree),
            institution: S(e.institution),
            year: S(e.year),
          }))
        : [];
    } else {
      // mode === "cv" → pasted CV text (or filename from upload)
      const pasted = S(
        body.oldCvText || body.old_cv_text || body.cvText || ""
      );
      const parsed = parseOldCvSmart(pasted);
      experiences = parsed.experiences;
      education = parsed.education;
    }

    // summary
    const topOfOldCv = S(body.oldCvText || "").split("\n").slice(0, 10).join(" ");
    const aiSummary = await buildSummary({
      profile,
      jd,
      sourceSummary: topOfOldCv,
      jdKeywords,
    });

    // docx content
    const children = [];

    if (profile.fullName) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 80 },
          children: [
            new TextRun({ text: profile.fullName, bold: true, size: 40 }),
          ],
        })
      );
    }

    if (profile.targetTitle) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 60 },
          children: [new TextRun({ text: profile.targetTitle, italics: true })],
        })
      );
    }

    const contact = [profile.email, profile.phone, profile.linkedin].filter(
      Boolean
    );
    if (contact.length) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 220 },
          children: [new TextRun(contact.join("  |  "))],
        })
      );
    }

    // summary
    children.push(label("PROFILE SUMMARY"));
    children.push(para(aiSummary));

    // skills
    const userSkills = profile.topSkills
      ? profile.topSkills.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const mergedSkills = Array.from(
      new Set([
        ...userSkills,
        ...jdKeywords.map((k) => k.replace(/^\w/, (c) => c.toUpperCase())),
      ])
    ).slice(0, 14);

    if (mergedSkills.length) {
      children.push(label("KEY SKILLS"));
      children.push(para(mergedSkills.join(" • ")));
    }

    // experience
    children.push(label("PROFESSIONAL EXPERIENCE"));
    if (experiences.length) {
      for (const role of experiences) {
        const head = [role.title, role.company].filter(Boolean).join(", ");
        if (head) {
          children.push(
            new Paragraph({
              spacing: { before: 120, after: 40 },
              children: [new TextRun({ text: head, bold: true })],
            })
          );
        }

        const sub = [
          role.location,
          [role.start, role.end].filter(Boolean).join(" – "),
        ]
          .filter(Boolean)
          .join("  |  ");
        if (sub) children.push(para(sub));

        let bulletsArr = role.bullets || [];

        if (bulletsArr.length) {
          bulletsArr = await enhanceExistingBullets({
            bullets: bulletsArr,
            role,
            jd,
            jdKeywords,
          });
        } else {
          bulletsArr = await buildBulletsForRole({
            role,
            jd,
            profile,
            jdKeywords,
          });
        }

        bulletsArr.forEach((b) => children.push(bullet(b)));
      }
    } else {
      children.push(para("Experience details available on request."));
    }

    // education
    children.push(label("EDUCATION"));
    if (education.length) {
      education.forEach((e) => {
        const line = [e.degree, e.institution, e.year]
          .filter(Boolean)
          .join(", ");
        if (line) children.push(para(line));
      });
    } else {
      children.push(para("Education details available on request."));
    }

    // build doc
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
    const filename = `HireEdge_${(profile.targetTitle || "CV").replace(
      /[^a-z0-9]+/gi,
      "_"
    )}.docx`;

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
    console.error("❌ AI resume generation failed:", err);
    return res.status(500).json({
      error: "AI resume generation failed",
      details: String(err),
    });
  }
}
