// pages/api/generate-resume.js
// HireEdge — AI CV Generator (improved: structured AI → docx)

import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import OpenAI from "openai";

const ALLOWED_ORIGIN = "https://hireedge.co.uk"; // change if needed
const S = (v) => (v ?? "").toString().trim();

// create client only if key exists
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// basic docx helpers
const label = (txt) =>
  new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text: txt, bold: true })],
  });
const para = (txt) => new Paragraph({ children: [new TextRun(txt)] });
const bullet = (txt) => new Paragraph({ text: txt, bullet: { level: 0 } });

/**
 * JD keyword helper — you can still reuse it to enrich skills
 */
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

/**
 * Your old smart parser — keep it in case you later want to parse pasted CV text
 */
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

    // experience like: 09/2022 to 08/2023
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

    // education like: 09/2024 Master of Science...
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

/* =========================================================
   NEW: single smart AI function that returns STRUCTURED CV
   ========================================================= */
async function generateAISections({ profile, jd, oldCvText }) {
  const client = getOpenAIClient();
  if (!client) {
    // no OpenAI key → return minimal structure
    return {
      summary: `Experienced ${profile.targetTitle || "professional"} aligned to the target role.`,
      skills: [],
      experience: [],
      education: [],
    };
  }

  const prompt = `
You are a UK-based professional CV writer for a career-tech SaaS.
Rewrite and modernise this candidate’s CV so it is aligned to the job below.
Use UK English, make it ATS-friendly, and keep it realistic (no fake KPIs).
Return ONLY valid JSON in this exact shape:

{
  "summary": "3-5 lines...",
  "skills": ["skill1", "skill2", "..."],
  "experience": [
    { "title": "...", "company": "...", "period": "...", "bullets": ["...","..."] }
  ],
  "education": [
    { "degree": "...", "institution": "...", "year": "..." }
  ]
}

JOB DESCRIPTION:
${jd}

CANDIDATE (PROFILE):
${JSON.stringify(profile, null, 2)}

CANDIDATE RAW CV / NOTES:
${oldCvText}
  `.trim();

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.45,
  });

  const text = resp.choices[0].message.content.trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // if model didn't return JSON, just put the text into summary
    parsed = {
      summary: text.slice(0, 500),
      skills: [],
      experience: [],
      education: [],
    };
  }

  return parsed;
}

/* ---------------- MAIN HANDLER ---------------- */

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
    // your original body parsing
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const jd = S(body.jd);

    const profile = {
      fullName: S(body?.profile?.fullName || body?.fullName),
      targetTitle: S(body?.profile?.targetTitle || body?.targetTitle),
      email: S(body?.profile?.email || body?.email),
      phone: S(body?.profile?.phone || body?.phone),
      linkedin: S(body?.profile?.linkedin || body?.linkedin),
      yearsExp: S(body?.profile?.yearsExp || body?.yearsExp),
      topSkills: S(body?.profile?.topSkills || body?.topSkills),
    };

    // this is whatever text the frontend sends
    const oldCvText =
      body.oldCvText || body.cvText || body.old_cv_text || "";

    // call the new smart AI engine
    const aiData = await generateAISections({
      profile,
      jd,
      oldCvText,
    });

    // unpack
    const aiSummary =
      aiData.summary ||
      `Experienced ${profile.targetTitle || "professional"} aligned to the role.`;
    const aiSkills = Array.isArray(aiData.skills) ? aiData.skills : [];
    const aiExperience = Array.isArray(aiData.experience)
      ? aiData.experience
      : [];
    const aiEducation = Array.isArray(aiData.education)
      ? aiData.education
      : [];

    // also get JD keywords to enrich skills
    const jdKeywords = extractKeywordsFromJD(jd, 8);
    const mergedSkills = Array.from(
      new Set([
        ...(profile.topSkills
          ? profile.topSkills.split(",").map((s) => s.trim())
          : []),
        ...aiSkills,
        ...jdKeywords.map((k) => k.replace(/^\w/, (c) => c.toUpperCase())),
      ])
    ).slice(0, 16);

    // start building docx
    const children = [];

    // header
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
    if (mergedSkills.length) {
      children.push(label("KEY SKILLS"));
      children.push(para(mergedSkills.join(" • ")));
    }

    // experience
    children.push(label("PROFESSIONAL EXPERIENCE"));
    if (aiExperience.length) {
      for (const role of aiExperience) {
        const head = [role.title, role.company].filter(Boolean).join(", ");
        if (head) {
          children.push(
            new Paragraph({
              spacing: { before: 120, after: 40 },
              children: [new TextRun({ text: head, bold: true })],
            })
          );
        }
        if (role.period) {
          children.push(para(role.period));
        }
        (role.bullets || []).forEach((b) => {
          if (b) children.push(bullet(b));
        });
      }
    } else {
      children.push(para("Experience details available on request."));
    }

    // education
    children.push(label("EDUCATION"));
    if (aiEducation.length) {
      aiEducation.forEach((e) => {
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
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error("❌ AI resume generation failed:", err);
    res
      .status(500)
      .json({ error: "AI resume generation failed", details: String(err) });
  }
}
