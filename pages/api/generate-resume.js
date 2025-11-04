// pages/api/generate-resume.js

import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import OpenAI from "openai";

// only your shop can call it
const ALLOWED_ORIGIN = "https://hireedge.co.uk";

// safe string
const S = (v) => (v ?? "").toString().trim();

/**
 * create OpenAI client only if we have key
 */
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/**
 * KEEP line breaks from pasted CV – the old version was removing them,
 * so we couldn’t tell where one role stopped and the next started.
 */
function cleanPlainText(txt = "") {
  return txt
    // remove HTML tags but keep line breaks
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    // normalise windows/mac line endings
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // trim extra spaces on each line
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * VERY LIGHT CV PARSER
 * goal: “if user pasted a CV and didn’t type roles/education manually,
 * take something usable from the paste”
 */
function parseOldCv(oldCvText = "") {
  const text = cleanPlainText(oldCvText);
  if (!text) return { exp: [], edu: [] };

  const lines = text.split("\n");

  const exp = [];
  const edu = [];

  let inExp = false;
  let inEdu = false;
  let currentExp = null;

  for (const raw of lines) {
    const line = raw.trim();

    if (!line) continue;

    // detect section headings
    if (/experience|work history|professional experience/i.test(line)) {
      inExp = true;
      inEdu = false;
      continue;
    }
    if (/education|academic|qualifications/i.test(line)) {
      inEdu = true;
      inExp = false;
      continue;
    }

    // EDUCATION LINES
    if (inEdu) {
      // simplest: line that has "BSc/MSc/Bachelor/Master/University"
      if (/(bsc|msc|b\.sc|m\.sc|bachelor|master|university|college|diploma)/i.test(line)) {
        edu.push({
          degree: line,
          institution: "",
          year: "",
        });
      }
      continue;
    }

    // EXPERIENCE LINES
    if (inExp) {
      // new role: looks like a title
      if (/(manager|analyst|engineer|consultant|officer|specialist|assistant|developer)/i.test(line)) {
        // close previous
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

      // bullet under current role
      if ((line.startsWith("-") || line.startsWith("•")) && currentExp) {
        currentExp.bullets.push(line.replace(/^[-•]\s?/, "").trim());
        continue;
      }

      // dates / locations inline e.g. "Jan 2021 – Present | London"
      if (currentExp && /(20\d{2}|present|ongoing)/i.test(line)) {
        currentExp.bullets.push(line);
        continue;
      }
    }
  }

  // push last role
  if (currentExp) exp.push(currentExp);

  return { exp, edu };
}

/**
 * GPT: make human summary
 */
async function generateSummary(profile, jd) {
  const client = getOpenAIClient();
  if (!client) {
    return `Results-driven ${profile.targetTitle || "professional"} with ${
      profile.yearsExp || "proven"
    } experience, skilled in ${profile.topSkills || "data analysis"}, seeking roles aligned to the provided JD.`;
  }

  const prompt = `
Write a 4–5 sentence UK-style CV summary.
Candidate:
- name: ${profile.fullName || "candidate"}
- target role: ${profile.targetTitle || "Data Analyst"}
- skills: ${profile.topSkills || "Power BI, SQL, Excel"}

Job description:
"""${jd}"""

Requirements:
- ATS friendly
- confident but not salesy
- mention data / outcomes / value
- UK spelling
  `;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.65,
  });

  return resp.choices[0].message.content.trim();
}

/**
 * GPT: bullets if user didn’t give experience
 */
async function generateExperienceBullets(profile, jd) {
  const client = getOpenAIClient();
  if (!client) {
    return [
      "Analysed and cleaned datasets to support reporting and decision-making.",
      "Built dashboards using Power BI/Excel to track KPIs.",
      "Collaborated with stakeholders to understand data needs.",
    ];
  }

  const prompt = `
Create 4 concise, action-oriented CV bullet points for a ${
    profile.targetTitle || "Data Analyst"
  } in the UK.
Use skills: ${profile.topSkills || "data analysis"}.
Align with this JD:
"""${jd}"""
Each bullet: strong verb + what + impact. UK spelling.`;

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

/* docx helpers */
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

  // quick browser check
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "HireEdge AI Resume API is alive ✅ send POST with JSON to get DOCX",
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

    // text pasted in Shopify form
    const oldCvText = cleanPlainText(
      body.oldCvText || body.old_cv_text || body.cvText || ""
    );

    // profile
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

    // if user pasted CV, try to fill gaps
    if (oldCvText) {
      const { exp: parsedExp, edu: parsedEdu } = parseOldCv(oldCvText);

      if (experiences.length === 0 && parsedExp.length) {
        experiences = parsedExp;
      }
      if (education.length === 0 && parsedEdu.length) {
        education = parsedEdu;
      }
    }

    // AI parts
    const aiSummary = await generateSummary(profile, jd);
    const aiBullets =
      experiences.length === 0
        ? await generateExperienceBullets(profile, jd)
        : [];

    // build docx
    const children = [];

    // header
    if (profile.fullName) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 80 },
          children: [new TextRun({ text: profile.fullName, bold: true, size: 40 })],
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
          spacing: { after: 240 },
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
      const skills = profile.topSkills
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .join(" • ");
      children.push(para(skills));
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
      // auto bullets
      aiBullets.forEach((b) => children.push(bullet(b)));
    }

    // education
    children.push(label("EDUCATION"));
    if (education.length) {
      education.forEach((e) => {
        const line = [e.degree, e.institution, e.year].filter(Boolean).join(", ");
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
  } catch (err) {
    console.error("❌ AI resume generation failed:", err);
    return res.status(500).json({
      error: "AI resume generation failed",
      details: String(err?.message || err),
    });
  }
}
