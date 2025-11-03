// api/generate-resume.js
import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

const ALLOWED_ORIGIN = "https://hireedge.co.uk"; // your Shopify domain

const S = (v) => (v ?? "").toString().trim();

function normalize(body) {
  const jd = S(body.jd);
  const profile = {
    fullName:    S(body?.profile?.fullName    || body?.fullName),
    targetTitle: S(body?.profile?.targetTitle || body?.targetTitle),
    email:       S(body?.profile?.email       || body?.email),
    phone:       S(body?.profile?.phone       || body?.phone),
    linkedin:    S(body?.profile?.linkedin    || body?.linkedin),
    yearsExp:    S(body?.profile?.yearsExp    || body?.yearsExp),
    topSkills:   S(body?.profile?.topSkills   || body?.topSkills),
  };

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
        : S(r?.bullets).split("\n").map((t) => t.trim()).filter(Boolean),
    }))
    .filter((r) => r.title || r.company || (r.bullets && r.bullets.length));

  let education = body?.education || body?.profile?.education || [];
  if (!Array.isArray(education)) education = [];
  education = education
    .map((e) => ({
      degree: S(e?.degree),
      institution: S(e?.institution),
      year: S(e?.year),
    }))
    .filter((e) => e.degree || e.institution || e.year);

  return { jd, profile, experiences, education };
}

const label = (txt) =>
  new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text: txt, bold: true })],
  });

const para = (txt) => new Paragraph({ children: [new TextRun(txt)] });
const bullet = (txt) => new Paragraph({ text: txt, bullet: { level: 0 } });

export default async function handler(req, res) {
  // 1️⃣ CORS headers
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // 2️⃣ Preflight request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // 3️⃣ Allow only POST
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { jd, profile, experiences, education } = normalize(body);

    const children = [];

    // ====== Document content ======
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
    if (jd || profile.yearsExp || profile.topSkills) {
      children.push(label("PROFILE SUMMARY"));
      const summary = jd
        ? `Experienced professional${profile.yearsExp ? ` with ${profile.yearsExp} years` : ""} targeting roles aligned with the provided job description.`
        : `Experienced professional${profile.yearsExp ? ` with ${profile.yearsExp} years` : ""}.`;
      children.push(para(summary));
    }
    if (profile.topSkills) {
      children.push(label("KEY SKILLS"));
      const skills = profile.topSkills.split(",").map((s) => s.trim()).filter(Boolean);
      if (skills.length) children.push(para(skills.join(" • ")));
    }
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
      children.push(para("Details available upon request."));
    }
    if (education.length) {
      children.push(label("EDUCATION"));
      education.forEach((e) => {
        const line = [e.degree, e.institution, e.year].filter(Boolean).join(", ");
        if (line) children.push(para(line));
      });
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
    const filename = `HireEdge_${(profile.targetTitle || "CV")
      .replace(/[^a-z0-9]+/gi, "_")
      .trim()}.docx`;

    // 4️⃣ Return the file (with CORS)
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error(err);
    res
      .status(400)
      .json({ error: "Failed to generate resume", details: String(err?.message || err) });
  }
}
