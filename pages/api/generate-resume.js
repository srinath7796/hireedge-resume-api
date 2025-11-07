// pages/api/generate-resume.js
// HireEdge — AI CV Generator (form-data version for Framer)

import formidable from "formidable";
import fs from "fs";

import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import OpenAI from "openai";

// ---------- CONFIG ----------
export const config = {
  api: {
    bodyParser: false, // 👈 important: we will parse form-data ourselves
  },
};

const ALLOWED_ORIGIN = "https://hireedge.co.uk"; // change if needed
const S = (v) => (v ?? "").toString().trim();

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ---------- small docx helpers ----------
const label = (txt) =>
  new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text: txt, bold: true })],
  });
const para = (txt) => new Paragraph({ children: [new TextRun(txt)] });
const bullet = (txt) => new Paragraph({ text: txt, bullet: { level: 0 } });

// ---------- JD keyword extractor ----------
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

// ---------- CV text parser (for pasted CVs) ----------
function parseOldCvSmart(raw = "") {
  const text = raw.replace(/\r/g, "\n");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const experiences = [];
  const education = [];

  const dateHeaderRe = /^(\d{2}\/\d{4})\s+(to|-)\s+(Present|\d{2}\/\d{4})/i;
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

// ---------- AI helpers ----------
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
Try to naturally include these JD keywords if they fit: ${jdKeywords.join(", ")}
Do NOT invent achievements.
Tone: professional, not robotic.

Candidate:
- Name: ${profile.fullName || "Candidate"}
- Target: ${profile.targetTitle || "role"}

Existing summary (may be empty):
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
      "Maintained strong client and stakeholder relationships.",
      "Supported business operations in a fast-paced setting.",
    ];
  }

  const prompt = `
Write 4 resume bullet points (UK English) for this role. No fake numbers.
Make it ATS-friendly and aligned to the job description.
If it is natural, include or echo these JD keywords: ${jdKeywords.join(", ")}
Avoid repeating the same keyword in every bullet.

Role: ${role.title || "Customer Service / Admin role"}

Job description:
"""${jd}"""
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.55,
  });

  return resp.choices[0].message.content
    .split("\n")
    .map((l) => l.replace(/^[-•]\s?/, "").trim())
    .filter(Boolean)
    .slice(0, 4);
}

async function enhanceExistingBullets({ bullets, role, jd, jdKeywords = [], profile }) {
  const client = getOpenAIClient();
  if (!client) return bullets;

  const prompt = `
Rewrite these CV bullets for the UK market.
- keep them true
- make them a bit more impact/ATS
- fit to this JD
- use some of: ${jdKeywords.join(", ")}

JD:
"""${jd}"""

Bullets:
${bullets.map((b) => "- " + b).join("\n")}

Return only bullets, one per line.
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

// ---------- MAIN HANDLER ----------
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "HireEdge AI Resume API alive ✅" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // 1) parse form-data from Framer
    const form = new formidable.IncomingForm();
    form.uploadDir = "/tmp";
    form.keepExtensions = true;

    form.parse(req, async (err, fields, files) => {
      if (err) {
        console.error("Form parse error:", err);
        return res.status(500).json({ error: "Failed to parse form" });
      }

      // ----- what we get from Framer -----
      const jd = S(fields.jd || fields.jobDescription);
      const email = S(fields.email);
      const fullName = S(fields.fullName || fields.name);
      const targetTitle = S(fields.targetTitle);

      // file (we're not parsing PDF/DOCX into text here yet)
      const cvFile = files.cv || files.file || files.resume;

      // if you had a textarea with pasted CV text in Framer, it will be here:
      const pastedCvText = S(fields.oldCvText || fields.cvText || "");

      // 2) build the rest of your original logic
      // choose mode: if user pasted CV text → use that, else fallback to manual
      const mode = pastedCvText ? "cv" : "manual";

      let experiences = [];
      let education = [];

      if (mode === "cv") {
        const parsed = parseOldCvSmart(pastedCvText);
        experiences = parsed.experiences;
        education = parsed.education;
      } else {
        // no pasted CV → at least create an empty experience list
        experiences = [];
        education = [];
      }

      const profile = {
        fullName,
        targetTitle,
        email,
        topSkills: S(fields.topSkills || fields.skills),
      };

      const jdKeywords = extractKeywordsFromJD(jd, 10);

      const aiSummary = await buildSummary({
        profile,
        jd,
        sourceSummary: "",
        jdKeywords,
      });

      // ---------- DOCX BUILD (same as your old code) ----------
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
      if (email) {
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 220 },
            children: [new TextRun(email)],
          })
        );
      }

      // summary
      children.push(label("PROFILE SUMMARY"));
      children.push(para(aiSummary));

      // skills
      const mergedSkills = jdKeywords.slice(0, 14);
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

          let bulletsArr = role.bullets || [];
          if (bulletsArr.length) {
            bulletsArr = await enhanceExistingBullets({
              bullets: bulletsArr,
              role,
              jd,
              jdKeywords,
              profile,
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
    });
  } catch (err) {
    console.error("❌ AI resume generation failed:", err);
    return res
      .status(500)
      .json({ error: "AI resume generation failed", details: String(err) });
  }
}
