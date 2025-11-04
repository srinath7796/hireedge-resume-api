// pages/api/generate-resume.js

import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import OpenAI from "openai";

const ALLOWED_ORIGIN = "https://hireedge.co.uk";
const S = (v) => (v ?? "").toString().trim();

/* -----------------------------
   create client only if we have key
------------------------------ */
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/* 1) clean pasted CV text (remove HTML) */
function cleanPlainText(txt = "") {
  return txt.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/* 2) try to pull exp / edu from pasted CV (very light) */
function parseOldCv(oldCvText = "") {
  const text = cleanPlainText(oldCvText);
  if (!text) return { exp: [], edu: [] };

  const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  const exp = [];
  const edu = [];

  const eduKeywords = /(msc|bsc|mba|master|bachelor|university|college|diploma)/i;
  const headerNoise = /(summary|profile|linkedin\.com|@|phone|gmail\.com)/i;

  let currentExp = null;
  for (const line of lines) {
    if (headerNoise.test(line)) continue;

    // education
    if (eduKeywords.test(line)) {
      edu.push({ degree: line, institution: "", year: "" });
      continue;
    }

    // looks like a job line
    if (/analyst|manager|executive|counsellor|engineer|consultant|assistant/i.test(line)) {
      if (currentExp) exp.push(currentExp);
      currentExp = {
        title: line,
        company: "",
        location: "",
        start: "",
        end: "",
        bullets: [],
      };
      continue;
    }

    // bullet under current job
    if ((line.startsWith("-") || line.startsWith("•")) && currentExp) {
      currentExp.bullets.push(line.replace(/^[-•]\s?/, "").trim());
    }
  }
  if (currentExp) exp.push(currentExp);

  return { exp, edu };
}

/* 3) GPT: make human + tailored summary */
async function generateSummary(profile, jd) {
  const client = getOpenAIClient();
  if (!client) {
    // fallback if no key
    return `Analytical ${profile.targetTitle || "professional"} with ${
      profile.yearsExp || "proven"
    } experience, skilled in ${profile.topSkills || "data analysis"}, targeting UK roles.`;
  }

  const prompt = `
Write a 4–5 line resume summary in UK English for:
Name: ${profile.fullName || "the candidate"}
Target role: ${profile.targetTitle || "Data Analyst"}
Skills: ${profile.topSkills || "Power BI, SQL, Excel"}

Job description to align with:
"""${jd}"""

Requirements:
- ATS friendly
- confident, not salesy
- mention results / value
  `;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
  });
  return resp.choices[0].message.content.trim();
}

/* 4) GPT: create 4–5 bullets for experience if user didn’t give any */
async function generateExperienceBullets(profile, jd) {
  const client = getOpenAIClient();
  if (!client) {
    return [
      "Cleaned and transformed datasets to support reporting.",
      "Developed dashboards in Power BI and Excel.",
    ];
  }

  const prompt = `
Create 4 action-based resume bullet points for a ${
    profile.targetTitle || "Data Analyst"
  } role in the UK.
Use skills: ${profile.topSkills || "data analysis"}.
Tailor to this JD:
"""${jd}"""
Each bullet: start with a verb, short, specific, ATS friendly.`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
  });

  return resp.choices[0].message.content
    .split("\n")
    .map((l) => l.replace(/^[-•]\s?/, "").trim())
    .filter(Boolean)
    .slice(0, 5);
}

/* 5) small docx helpers */
const label = (txt) =>
  new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text: txt, bold: true })],
  });

const para = (txt) => new Paragraph({ children: [new TextRun(txt)] });
const bullet = (txt) => new Paragraph({ text: txt, bullet: { level: 0 } });

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "AI Resume API alive. Send POST with profile + jd.",
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    const jd = S(body.jd);
    const oldCvText = cleanPlainText(
      body.oldCvText || body.old_cv_text || body.cvText || ""
    );

    const profile = {
      fullName: S(body?.profile?.fullName || body?.fullName),
      targetTitle: S(body?.profile?.targetTitle || body?.targetTitle),
      email: S(body?.profile?.email || body?.email),
      phone: S(body?.profile?.phone || body?.phone),
      linkedin: S(body?.profile?.linkedin || body?.linkedin),
      yearsExp: S(body?.profile?.yearsExp || body?.yearsExp),
      topSkills: S(body?.profile?.topSkills || body?.topSkills),
    };

    // experience from form
    let experiences =
      body?.experience ||
      body?.experiences ||
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

    // education from form
    let education = body?.education || body?.profile?.education || [];
    if (!Array.isArray(education)) education = [];
    education = education
      .map((e) => ({
        degree: S(e?.degree),
        institution: S(e?.institution),
        year: S(e?.year),
      }))
      .filter((e) => e.degree || e.institution || e.year);

    // if user pasted old CV, try to fill gaps
    if (oldCvText) {
      const { exp: parsedExp, edu: parsedEdu } = parseOldCv(oldCvText);
      if (experiences.length === 0 && parsedExp.length) {
        experiences = parsedExp;
      }
      if (education.length === 0 && parsedEdu.length) {
        education = parsedEdu;
      }
    }

    // call GPT for summary & bullets
    const aiSummary = await generateSummary(profile, jd);
    const aiBullets =
      experiences.length === 0
        ? await generateExperienceBullets(profile, jd)
        : [];

    // start building doc
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
    const contact = [profile.email, profile.phone, profile.linkedin].filter(Boolean);
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
    if (profile.topSkills) {
      children.push(label("KEY SKILLS"));
      children.push(
        para(
          profile.topSkills
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .join(" • ")
        )
      );
    }

    // experience
    children.push(label("PROFESSIONAL EXPERIENCE"));
    if (experiences.length) {
      experiences.forEach((r) => {
        const head = [r.title, r.company].filter(Boolean).join(", ");
        if (head) {
          children.push(
            new Paragraph({
              spacing: { before: 120, after: 40 },
              children: [new TextRun({ text: head, bold: true })],
            })
          );
        }
        const sub = [r.location, [r.start, r.end].filter(Boolean).join(" – ")]
          .filter(Boolean)
          .join("  |  ");
        if (sub) children.push(para(sub));
        (r.bullets || []).forEach((b) => children.push(bullet(b)));
      });
    } else {
      // no experience in form or CV → use AI bullets
      children.push(
        new Paragraph({
          spacing: { before: 120, after: 40 },
          children: [
            new TextRun({
              text: profile.targetTitle || "Relevant Experience",
              bold: true,
            }),
          ],
        })
      );
      aiBullets.forEach((b) => children.push(bullet(b)));
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

    // build docx
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
      details: String(err?.message || err),
    });
  }
}
