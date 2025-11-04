// pages/api/generate-resume.js
import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import OpenAI from "openai";

const ALLOWED_ORIGIN = "https://hireedge.co.uk"; // your Shopify domain
const S = (v) => (v ?? "").toString().trim();

/* create OpenAI client only if key is present */
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/* 1) strip HTML + squish spaces */
function cleanPlainText(txt = "") {
  return txt.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/* 2) parse pasted CV that looks like the one you sent */
function parseOldCvSmart(raw = "") {
  const text = raw.replace(/\r/g, "\n");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const experiences = [];
  const education = [];

  // patterns
  const dateHeaderRe =
    /^(\d{2}\/\d{4})\s+(to|-)\s+(Present|\d{2}\/\d{4})/i; // e.g. 09/2022 to 08/2023
  const eduDateRe = /^(\d{2}\/\d{4})\s+/; // e.g. 09/2024 Master of Science...
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // EXPERIENCE BLOCK --------------------------------------------
    if (dateHeaderRe.test(line)) {
      const m = line.match(dateHeaderRe);
      const start = m[1];
      const end = m[3];
      // title is usually the next line
      const title = lines[i + 1] || "";
      // company is next line after title (your CV: "upGrad Abroad - Bengaluru, India")
      const company = lines[i + 2] || "";
      const bullets = [];
      let j = i + 3;
      while (j < lines.length && lines[j].startsWith("•")) {
        bullets.push(lines[j].replace(/^•\s?/, "").trim());
        j++;
      }
      experiences.push({
        title: S(title),
        company: S(company),
        location: "",
        start: start,
        end: end,
        bullets,
      });
      i = j;
      continue;
    }

    // EDUCATION BLOCK --------------------------------------------
    // your CV puts date first: 09/2024 Master of Science: Data Science
    if (eduDateRe.test(line)) {
      // grab the date + the rest
      const dateMatch = line.match(eduDateRe);
      const year = dateMatch[1].slice(3); // from 09/2024 -> 2024
      const degree = line.replace(eduDateRe, "").trim();
      // next line is usually institution
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

/* 3) GPT helper: summary */
async function buildSummary(profile, jd, rawCvTop) {
  const client = getOpenAIClient();
  const base =
    rawCvTop ||
    `Experienced professional seeking a ${profile.targetTitle || "role"} in the UK.`;

  if (!client) {
    // fallback
    return `${base} Strong in ${profile.topSkills || "key skills"} and able to align to UK job requirements.`;
  }

  const prompt = `
You are a CV writer for UK roles.
Rewrite the candidate's summary so it is 4 sentences, ATS-friendly, and aligned to this job description.
Do NOT invent metrics. Only use information from the candidate and the JD.

Candidate name: ${profile.fullName || "Candidate"}
Target role: ${profile.targetTitle || "Sales Manager"}
Candidate skills: ${profile.topSkills || "N/A"}

Original / pasted summary or CV top:
"""${rawCvTop}"""

Job description:
"""${jd}"""

Return just the rewritten summary.
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.6,
  });

  return resp.choices[0].message.content.trim();
}

/* 4) GPT helper: fill bullets ONLY if none exist */
async function buildBulletsForRole(role, jd, profile) {
  const client = getOpenAIClient();
  if (!client) {
    return [
      "Supported business objectives by maintaining strong client relationships.",
      "Collaborated with cross-functional teams to deliver service on time.",
    ];
  }

  const prompt = `
Write 4 bullet points for this role so it fits the JD.
Do NOT make up numbers.
Use UK English, start with a verb, keep each under 22 words.

Role title: ${role.title || "Role"}
Company: ${role.company || ""}
Job description:
"""${jd}"""

Candidate skills: ${profile.topSkills || "N/A"}
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.6,
  });

  return resp.choices[0].message.content
    .split("\n")
    .map((l) => l.replace(/^[-•]\s?/, "").trim())
    .filter(Boolean)
    .slice(0, 4);
}

/* 5) docx helpers */
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

  // quick test
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "HireEdge Resume API is alive ✅ send POST to get DOCX",
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const jd = S(body.jd);
    const pastedCv = body.oldCvText || body.old_cv_text || body.cvText || "";
    const cleanedCv = cleanPlainText(pastedCv);

    const profile = {
      fullName: S(body?.profile?.fullName || body?.fullName),
      targetTitle: S(body?.profile?.targetTitle || body?.targetTitle),
      email: S(body?.profile?.email || body?.email),
      phone: S(body?.profile?.phone || body?.phone),
      linkedin: S(body?.profile?.linkedin || body?.linkedin),
      yearsExp: S(body?.profile?.yearsExp || body?.yearsExp),
      topSkills: S(body?.profile?.topSkills || body?.topSkills),
    };

    // 1) experiences from form
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

    // 2) education from form
    let education = body?.education || body?.profile?.education || [];
    if (!Array.isArray(education)) education = [];
    education = education
      .map((e) => ({
        degree: S(e?.degree),
        institution: S(e?.institution),
        year: S(e?.year),
      }))
      .filter((e) => e.degree || e.institution || e.year);

    // 3) if user pasted CV, try to pull missing stuff from it
    if (pastedCv) {
      const parsed = parseOldCvSmart(pastedCv);
      if (experiences.length === 0 && parsed.experiences.length) {
        experiences = parsed.experiences;
      }
      if (education.length === 0 && parsed.education.length) {
        education = parsed.education;
      }
    }

    // 4) build summary (use first part of pasted CV as source)
    const aiSummary = await buildSummary(
      profile,
      jd,
      pastedCv.split("\n").slice(0, 12).join(" ")
    );

    // 5) build docx
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
        const sub = [role.location, [role.start, role.end].filter(Boolean).join(" – ")]
          .filter(Boolean)
          .join("  |  ");
        if (sub) children.push(para(sub));

        let bulletsArr = role.bullets || [];
        if (!bulletsArr.length) {
          // ask GPT to make some for THIS role
          bulletsArr = await buildBulletsForRole(role, jd, profile);
        }
        bulletsArr.forEach((b) => children.push(bullet(b)));
      }
    } else {
      // completely empty – add 1 generic block
      const fakeRole = {
        title: profile.targetTitle || "Relevant Experience",
        company: "",
      };
      const bulletsArr = await buildBulletsForRole(fakeRole, jd, profile);
      children.push(
        new Paragraph({
          spacing: { before: 120, after: 40 },
          children: [
            new TextRun({
              text: fakeRole.title,
              bold: true,
            }),
          ],
        })
      );
      bulletsArr.forEach((b) => children.push(bullet(b)));
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
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error("❌ AI resume generation failed:", err);
    res.status(500).json({
      error: "AI resume generation failed",
      details: String(err?.message || err),
    });
  }
}
