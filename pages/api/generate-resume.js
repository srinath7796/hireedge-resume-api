// pages/api/generate-resume.js
// HireEdge — AI CV Generator (with JD keyword injection + bullet enhancement)

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

// small docx helpers
const label = (txt) =>
  new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text: txt, bold: true })],
  });
const para = (txt) => new Paragraph({ children: [new TextRun(txt)] });
const bullet = (txt) => new Paragraph({ text: txt, bullet: { level: 0 } });

/**
 * Better JD keyword extractor
 * - ignores super-common words
 * - ignores very short words
 * - keeps only top N
 */
function extractKeywordsFromJD(jd = "", limit = 10) {
  if (!jd) return [];
  const text = jd.toLowerCase();
  const words = text.split(/[^a-z0-9+]+/).filter(Boolean);

  // words we never want in skills
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
    "customer", // we'll already have it anyway
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
    if (w.length < 4) continue; // drop tiny words
    counts[w] = (counts[w] || 0) + 1;
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)
    .slice(0, limit);
}

// parse pasted CV into experience + education
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

/* ---------- AI helpers ---------- */

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
- Skills: ${profile.topSkills || "N/A"}

Existing summary (may be empty):
"""${sourceSummary || ""}"""

Job description:
"""${jd}"""

Return only the final summary.
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.35, // a bit tighter, less waffle
  });

  return resp.choices[0].message.content.trim();
}

// generates fresh bullets when there are none
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
Company: ${role.company || ""}

Job description to align to:
"""${jd}"""

Candidate skills: ${profile.topSkills || "N/A"}

Return only the bullets, one per line.
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

// NEW: enhances existing user bullets so they match the JD & add ATS language
async function enhanceExistingBullets({ bullets, role, jd, jdKeywords = [], profile }) {
  const client = getOpenAIClient();
  if (!client) return bullets; // no AI → keep original

  const prompt = `
You are rewriting CV bullet points for the UK market.
Rewrite the bullets below so they:
1) stay factually true (same responsibilities),
2) sound more achievement/impact-oriented,
3) are aligned to this job description,
4) naturally include some of these JD keywords if they fit: ${jdKeywords.join(", ")},
5) avoid making up numbers or fake KPIs.

Role: ${role.title || "Customer Service / Admin role"}

Job description:
"""${jd}"""

Original bullets:
${bullets.map((b) => "- " + b).join("\n")}

Return ONLY the improved bullets, one per line, no numbering.
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

  // keep length similar
  return rewritten.length ? rewritten : bullets;
}

/* ---------- main handler ---------- */

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
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const mode = body.mode === "cv" ? "cv" : "manual"; // default manual
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

    let experiences = [];
    let education = [];

    if (mode === "manual") {
      experiences =
        body.experience ||
        body.experiences ||
        body?.profile?.experiences ||
        [];
      if (!Array.isArray(experiences)) experiences = [];
      experiences = experiences
        .map((r) => ({
          title: S(r?.title),
          company: S(r?.company),
          location: S(r?.location),
          start: S(r?.start),
          end: S(r?.end),
          bullets: Array.isArray(r?.bullets)
            ? r.bullets.map(S).filter(Boolean)
            : S(r?.bullets)
                .split("\n")
                .map((t) => t.trim())
                .filter(Boolean),
        }))
        .filter((r) => r.title || r.company || (r.bullets && r.bullets.length));

      education = body.education || body?.profile?.education || [];
      if (!Array.isArray(education)) education = [];
      education = education
        .map((e) => ({
          degree: S(e?.degree),
          institution: S(e?.institution),
          year: S(e?.year),
        }))
        .filter((e) => e.degree || e.institution || e.year);
    } else {
      // mode === "cv"
      const pasted = body.oldCvText || body.old_cv_text || body.cvText || "";
      const parsed = parseOldCvSmart(pasted);
      experiences = parsed.experiences;
      education = parsed.education;
    }

    // extract JD keywords up front
    const jdKeywords = extractKeywordsFromJD(jd, 10);

    // build summary
    const pastedTop =
      (body.oldCvText || "").split("\n").slice(0, 10).join(" ");
    const aiSummary = await buildSummary({
      profile,
      jd,
      sourceSummary: pastedTop,
      jdKeywords,
    });

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

    // skills – merge user skills + JD keywords, then cap length
    const userSkills = profile.topSkills
      ? profile.topSkills.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const mergedSkills = Array.from(
      new Set([
        ...userSkills,
        ...jdKeywords.map((k) => k.replace(/^\w/, (c) => c.toUpperCase())),
      ])
    );
    const limitedSkills = mergedSkills.slice(0, 14); // cap
    if (limitedSkills.length) {
      children.push(label("KEY SKILLS"));
      children.push(para(limitedSkills.join(" • ")));
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
          // NEW: enhance existing bullets to match JD
          bulletsArr = await enhanceExistingBullets({
            bullets: bulletsArr,
            role,
            jd,
            jdKeywords,
            profile,
          });
        } else {
          // no bullets -> generate fresh
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
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error("❌ AI resume generation failed:", err);
    res
      .status(500)
      .json({ error: "AI resume generation failed", details: String(err) });
  }
}
