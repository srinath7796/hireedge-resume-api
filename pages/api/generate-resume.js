import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

// your Shopify domain
const ALLOWED_ORIGIN = "https://hireedge.co.uk";

// helper to safely trim values
const S = (v) => (v ?? "").toString().trim();

// normalize incoming body (same as yours)
function normalize(body) {
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

export default async function handler(req, res) {
  // 1) CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // 2) preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // 3) GET = quick health check
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message:
        "HireEdge resume API is alive. Send POST with candidate data to get a DOCX.",
    });
  }

  // 4) only POST after this
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 5) parse body safely
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch (err) {
    return res.status(400).json({
      error: "Invalid JSON body",
      details: String(err?.message || err),
    });
  }

  const { jd, profile, experiences, education } = normalize(body);

  // 6) NOW load docx inside try — so bad import won’t crash the whole function
  let AlignmentType, Document, Packer, Paragraph, TextRun;
  try {
    const docx = await import("docx");
    AlignmentType = docx.AlignmentType;
    Document = docx.Document;
    Packer = docx.Packer;
    Paragraph = docx.Paragraph;
    TextRun = docx.TextRun;
  } catch (err) {
    console.error("Failed to import docx on Vercel:", err);
    return res.status(500).json({
      error: "docx library could not be loaded on the server",
      details: String(err?.message || err),
    });
  }

  // 7) helper paragraph builders (now that we have docx)
  const label = (txt) =>
    new Paragraph({
      spacing: { before: 200, after: 80 },
      children: [new TextRun({ text: txt, bold: true })],
    });

  const para = (txt) => new Paragraph({ children: [new TextRun(txt)] });
  const bullet = (txt) =>
    new Paragraph({ text: txt, bullet: { level: 0 } });

  try {
    const children = [];

    // Name
    if (profile.fullName) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 80 },
          children: [new TextRun({ text: profile.fullName, bold: true, size: 40 })],
        })
      );
    }

    // Title
    if (profile.targetTitle) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 60 },
          children: [new TextRun({ text: profile.targetTitle, italics: true })],
        })
      );
    }

    // Contact
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

    // Summary
    if (jd || profile.yearsExp || profile.topSkills) {
      children.push(label("PROFILE SUMMARY"));
      const summary = jd
        ? `Experienced professional${profile.yearsExp ? ` with ${profile.yearsExp} years` : ""} targeting roles aligned with the provided job description.`
        : `Experienced professional${profile.yearsExp ? ` with ${profile.yearsExp} years` : ""}.`;
      children.push(para(summary));
    }

    // Skills
    if (profile.topSkills) {
      children.push(label("KEY SKILLS"));
      const skills = profile.topSkills
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (skills.length) children.push(para(skills.join(" • ")));
    }

    // Experience
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

    // Education
    if (education.length) {
      children.push(label("EDUCATION"));
      education.forEach((e) => {
        const line = [e.degree, e.institution, e.year]
          .filter(Boolean)
          .join(", ");
        if (line) children.push(para(line));
      });
    }

    // Build document
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
    console.error("❌ Resume generation failed:", err);
    return res.status(500).json({
      error: "Resume generation failed",
      details: String(err?.message || err),
    });
  }
}
