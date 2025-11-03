// pages/api/generate-resume.js

import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

// ✅ your Shopify domain
const ALLOWED_ORIGIN = "https://hireedge.co.uk";
const S = (v) => (v ?? "").toString().trim();

/* ------------------ helpers ------------------ */

// strip HTML / extra spaces
function cleanPlainText(txt = "") {
  let out = txt.replace(/<[^>]*>/g, " ");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

// pull up to 4 good lines from JD, skip marketing intros
function extractJDBullets(jd = "") {
  if (!jd) return [];
  const badStarts = [
    "what if your next job",
    "what if it brought",
    "bam is where",
    "building a sustainable tomorrow",
    "join us in making possible",
  ];

  const parts = jd
    .split(/\r?\n|\. +/)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => {
      const lower = p.toLowerCase();
      return !badStarts.some((b) => lower.startsWith(b));
    });

  // favour lines that look like responsibilities
  const good = parts.filter((p) =>
    /(data|analysis|report|power bi|sql|dashboard|stakeholder|insight|clean)/i.test(
      p
    )
  );

  const chosen = good.length ? good : parts;
  return chosen.slice(0, 4);
}

// very light parser for pasted CV (optional)
function parseOldCv(oldCvText = "") {
  const text = cleanPlainText(oldCvText);
  if (!text) return { exp: [], edu: [] };

  const lines = text
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  const exp = [];
  const edu = [];
  const eduKeywords =
    /(msc|bsc|mba|master|bachelor|university|college|pgdip|diploma)/i;
  const headerNoise = /(summary|profile|linkedin\.com|@|phone|gmail\.com)/i;

  let currentExp = null;
  for (const line of lines) {
    if (headerNoise.test(line)) continue;

    if (eduKeywords.test(line)) {
      edu.push({
        degree: line,
        institution: "",
        year: "",
      });
      continue;
    }

    // guess job line
    if (
      /analyst|manager|executive|engineer|consultant|counsellor/i.test(line)
    ) {
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

    if ((line.startsWith("-") || line.startsWith("•")) && currentExp) {
      currentExp.bullets.push(line.replace(/^[-•]\s?/, "").trim());
    }
  }
  if (currentExp) exp.push(currentExp);

  return { exp, edu };
}

// create fake experience if user sent none
function buildDefaultExperience(jdBullets = [], topSkills = "") {
  const skillText = topSkills
    ? topSkills.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const bullets = [];

  // from JD
  jdBullets.forEach((b) => {
    bullets.push(b);
  });

  // from skills
  if (skillText.length) {
    bullets.push(
      `Built and refreshed reports/dashboards using ${skillText.join(", ")}.`
    );
  }

  // add 1–2 generic DA bullets
  bullets.push(
    "Cleaned and validated incoming datasets to improve reporting accuracy."
  );
  bullets.push(
    "Collaborated with stakeholders to understand data needs and present insights."
  );

  return [
    {
      title: "Data Analyst",
      company: "HireEdge (Sample Project)",
      location: "United Kingdom",
      start: "",
      end: "Present",
      bullets: bullets.slice(0, 6),
    },
  ];
}

// create default education if user sent none
function buildDefaultEducation() {
  return [
    {
      degree: "MSc / BSc (Analytics / Business) – sample entry",
      institution: "UK Institution",
      year: "",
    },
  ];
}

/* ------------------ normalize request ------------------ */

function normalize(body) {
  const jd = S(body.jd);
  const oldCvRaw =
    body.oldCvText || body.old_cv_text || body.oldCv || body.cvText || "";
  const oldCvText = cleanPlainText(oldCvRaw);

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
    body?.work_experience ||
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

  // try to auto-fill from pasted CV
  if (oldCvText) {
    const { exp: parsedExp, edu: parsedEdu } = parseOldCv(oldCvText);
    if (experiences.length === 0 && parsedExp.length) {
      experiences = parsedExp;
    }
    if (education.length === 0 && parsedEdu.length) {
      education = parsedEdu;
    }
  }

  return { jd, oldCvText, profile, experiences, education };
}

/* ------------------ doc helpers ------------------ */

const label = (txt) =>
  new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text: txt, bold: true })],
  });

const para = (txt) => new Paragraph({ children: [new TextRun(txt)] });
const bullet = (txt) => new Paragraph({ text: txt, bullet: { level: 0 } });

/* ------------------ handler ------------------ */

export default async function handler(req, res) {
  try {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.status(200).end();

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

    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { jd, oldCvText, profile, experiences, education } = normalize(body);

    // turn JD into bullets
    const jdBullets = extractJDBullets(jd);

    // if user didn’t send experience at all → create a default DA experience
    let finalExperiences = experiences;
    if (!finalExperiences || finalExperiences.length === 0) {
      finalExperiences = buildDefaultExperience(
        jdBullets,
        profile.topSkills || ""
      );
    }

    // if no education → add default
    let finalEducation = education;
    if (!finalEducation || finalEducation.length === 0) {
      finalEducation = buildDefaultEducation();
    }

    const children = [];

    // HEADER
    if (profile.fullName) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 80 },
          children: [
            new TextRun({
              text: profile.fullName,
              bold: true,
              size: 40,
            }),
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

    // PROFILE SUMMARY
    children.push(label("PROFILE SUMMARY"));

    const summaryParts = [];
    summaryParts.push(
      profile.targetTitle
        ? `Analytical and detail-oriented ${profile.targetTitle}`
        : "Analytical and detail-oriented professional"
    );
    if (profile.yearsExp)
      summaryParts.push(`with ${profile.yearsExp} years’ experience`);
    if (profile.topSkills)
      summaryParts.push(
        `skilled in ${profile.topSkills
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 5)
          .join(", ")}`
      );
    if (jdBullets.length) summaryParts.push("aligned to the attached JD");

    children.push(para(summaryParts.join(", ") + "."));

    // add JD bullets as “role requirements matched”
    jdBullets.forEach((b) => children.push(bullet(b)));

    // KEY SKILLS
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

    // EXPERIENCE
    children.push(label("PROFESSIONAL EXPERIENCE"));
    finalExperiences.forEach((r) => {
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

    // EDUCATION
    children.push(label("EDUCATION"));
    finalEducation.forEach((e) => {
      const line = [e.degree, e.institution, e.year]
        .filter(Boolean)
        .join(", ");
      if (line) children.push(para(line));
    });

    // build document
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
    console.error("❌ Resume generation failed:", err);
    res.status(500).json({
      error: "Resume generation failed",
      details: String(err?.message || err),
    });
  }
}
