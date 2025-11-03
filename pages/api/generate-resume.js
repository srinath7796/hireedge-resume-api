// pages/api/generate-resume.js
import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

const ALLOWED_ORIGIN = "https://hireedge.co.uk";
const S = (v) => (v ?? "").toString().trim();

/**
 * Remove HTML tags and very long inline scripts/styles from pasted CV.
 */
function cleanPlainText(txt = "") {
  let out = txt.replace(/<[^>]*>/g, " ");        // strip tags
  out = out.replace(/\s+/g, " ").trim();         // collapse spaces
  return out;
}

/**
 * Take JD and return up to 4 useful bullet-like lines.
 * Drops employer marketing lines like "What if your next job..."
 */
function extractJDBullets(jd = "") {
  if (!jd) return [];
  const badStarts = [
    "what if your next job",
    "what if it brought",
    "and it's also where",
    "bam is where",
    "building a sustainable tomorrow",
  ];

  const parts = jd
    .split(/\r?\n|\. +/)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => {
      const lower = p.toLowerCase();
      return !badStarts.some((b) => lower.startsWith(b));
    });

  // keep only lines that look like responsibilities/requirements
  const filtered = parts.filter((p) =>
    /experience|data|analysis|report|stakeholder|deliver|support|skills|power bi|sql/i.test(p)
  );

  const chosen = filtered.length ? filtered : parts;
  return chosen.slice(0, 4);
}

/**
 * Very light parser for pasted CV to extract exp/education
 */
function parseOldCv(oldCvText = "") {
  const text = cleanPlainText(oldCvText);
  if (!text) return { exp: [], edu: [] };

  const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);

  const exp = [];
  const edu = [];

  const dateLike = /(20\d{2}|19\d{2})/;
  const eduKeywords = /(msc|bsc|mba|master|bachelor|university|college|pgdm|pgdip|diploma)/i;
  const headerNoise = /(summary|profile|linkedin\.com|@|phone|gmail\.com)/i;

  let currentExp = null;

  for (const line of lines) {
    if (!line || headerNoise.test(line)) continue;

    if (eduKeywords.test(line)) {
      edu.push({
        degree: line,
        institution: "",
        year: (line.match(dateLike) || [])[0] || "",
      });
      continue;
    }

    // start of a job line
    if (dateLike.test(line) || /manager|analyst|executive|counsellor|engineer/i.test(line)) {
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

    // bullet lines in pasted CV
    if ((line.startsWith("-") || line.startsWith("•")) && currentExp) {
      currentExp.bullets.push(line.replace(/^[-•]\s?/, "").trim());
    }
  }
  if (currentExp) exp.push(currentExp);

  return { exp, edu };
}

function normalize(body) {
  const jd = S(body.jd);
  const oldCvRaw = body.oldCvText || body.old_cv_text || body.oldCv || "";
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

  // structured exp from form
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

  // structured edu from form
  let education = body?.education || body?.profile?.education || [];
  if (!Array.isArray(education)) education = [];
  education = education
    .map((e) => ({
      degree: S(e?.degree),
      institution: S(e?.institution),
      year: S(e?.year),
    }))
    .filter((e) => e.degree || e.institution || e.year);

  // if user pasted old CV, fill gaps only
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

const label = (txt) =>
  new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text: txt, bold: true })],
  });

const para = (txt) => new Paragraph({ children: [new TextRun(txt)] });
const bullet = (txt) => new Paragraph({ text: txt, bullet: { level: 0 } });

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

    const jdBullets = extractJDBullets(jd);

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

    // PROFILE SUMMARY (AI-ish, short)
    children.push(label("PROFILE SUMMARY"));
    const summaryParts = [];
    if (profile.targetTitle) summaryParts.push(`Data professional targeting ${profile.targetTitle} roles`);
    else summaryParts.push("Results-driven professional");
    if (profile.yearsExp) summaryParts.push(`with ${profile.yearsExp} years' experience`);
    if (jdBullets.length) summaryParts.push("aligned to role requirements");
    children.push(para(summaryParts.join(", ") + "."));

    // add JD highlights as bullets (max 4)
    jdBullets.forEach((b) => children.push(bullet(b)));

    // KEY SKILLS
    if (profile.topSkills) {
      children.push(label("KEY SKILLS"));
      const skills = profile.topSkills.split(",").map((s) => s.trim()).filter(Boolean);
      if (skills.length) {
        children.push(para(skills.join(" • ")));
      }
    }

    // EXPERIENCE
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

        const bullets = (r.bullets && r.bullets.length)
          ? r.bullets
          : ["Supported business and stakeholder needs with day-to-day tasks."];

        bullets.forEach((b) => children.push(bullet(b)));
      });
    } else {
      children.push(para("Experience details can be populated automatically from the pasted CV."));
    }

    // EDUCATION
    children.push(label("EDUCATION"));
    if (education.length) {
      education.forEach((e) => {
        const line = [e.degree, e.institution, e.year].filter(Boolean).join(", ");
        if (line) children.push(para(line));
      });
    } else {
      children.push(para("Education details available upon request."));
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
    const filename = `HireEdge_${(profile.targetTitle || "CV").replace(/[^a-z0-9]+/gi, "_")}.docx`;

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
