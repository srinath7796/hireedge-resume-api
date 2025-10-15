// /pages/api/generate-resume.js  (Next 12/13 pages router)
// If you're using the App Router, adapt to a route handler and return NextResponse.

// npm i docx@9
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TabStopPosition,
  TabStopType,
  TextRun,
} from "docx";

function normStr(v) {
  return (v ?? "").toString().trim();
}

function normalizePayload(body) {
  // Core fields
  const jd = normStr(body.jd);

  // profile block
  const profile = {
    fullName: normStr(body?.profile?.fullName || body?.fullName),
    targetTitle: normStr(body?.profile?.targetTitle || body?.targetTitle),
    email: normStr(body?.profile?.email || body?.email),
    phone: normStr(body?.profile?.phone || body?.phone),
    linkedin: normStr(body?.profile?.linkedin || body?.linkedin),
    yearsExp: normStr(body?.profile?.yearsExp || body?.yearsExp),
    topSkills: normStr(body?.profile?.topSkills || body?.topSkills),
  };

  // experience can arrive in multiple places/shapes
  let experiences =
    body?.experience ||
    body?.experiences ||
    body?.work_experience ||
    body?.profile?.experiences ||
    [];

  if (!Array.isArray(experiences)) experiences = [];

  experiences = experiences
    .map((r) => ({
      title: normStr(r?.title),
      company: normStr(r?.company),
      location: normStr(r?.location),
      start: normStr(r?.start),
      end: normStr(r?.end),
      bullets: Array.isArray(r?.bullets)
        ? r.bullets.map((b) => normStr(b)).filter(Boolean)
        : (normStr(r?.bullets) || "")
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
    }))
    .filter(
      (r) =>
        r.title || r.company || (Array.isArray(r.bullets) && r.bullets.length)
    );

  // education
  let education = body?.education || body?.profile?.education || [];
  if (!Array.isArray(education)) education = [];
  education = education
    .map((e) => ({
      degree: normStr(e?.degree),
      institution: normStr(e?.institution),
      year: normStr(e?.year),
    }))
    .filter((e) => e.degree || e.institution || e.year);

  return { jd, profile, experiences, education };
}

function heading(text, size = 20) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 },
    children: [
      new TextRun({ text, bold: true }),
    ],
  });
}

function label(text) {
  return new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text, bold: true })],
  });
}

function para(text) {
  return new Paragraph({ children: [new TextRun(text)] });
}

function bullet(text) {
  return new Paragraph({
    text,
    bullet: { level: 0 },
    spacing: { after: 60 },
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const { jd, profile, experiences, education } = normalizePayload(body);

    // Build the DOCX
    const children = [];

    // Name (centered big)
    if (profile.fullName) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 80 },
          children: [
            new TextRun({
              text: profile.fullName,
              bold: true,
              size: 40, // ~20pt
            }),
          ],
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

    // Contact line with tab stops
    const contactBits = [
      profile.email,
      profile.phone,
      profile.linkedin,
    ].filter(Boolean);
    if (contactBits.length) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 240 },
          children: [new TextRun(contactBits.join("  |  "))],
        })
      );
    }

    // Profile Summary (use JD + yearsExp to shape tone, but keep simple)
    if (jd || profile.yearsExp || profile.topSkills) {
      children.push(label("PROFILE SUMMARY"));
      const summary = jd
        ? `Experienced professional${profile.yearsExp ? ` with ${profile.yearsExp} years` : ""} targeting roles aligned with the job description provided.`
        : `Experienced professional${profile.yearsExp ? ` with ${profile.yearsExp} years` : ""}.`;
      children.push(para(summary));
    }

    // Key Skills
    if (profile.topSkills) {
      children.push(label("KEY SKILLS"));
      const skills =
        profile.topSkills
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean) || [];
      if (skills.length) {
        // render as a single line separated by •
        children.push(para(skills.join(" • ")));
      }
    }

    // Professional Experience
    children.push(label("PROFESSIONAL EXPERIENCE"));
    if (experiences.length) {
      experiences.forEach((r) => {
        const line1 = [r.title, r.company].filter(Boolean).join(", ");
        if (line1) {
          children.push(
            new Paragraph({
              spacing: { before: 120, after: 40 },
              children: [new TextRun({ text: line1, bold: true })],
            })
          );
        }
        const line2 = [r.location, [r.start, r.end].filter(Boolean).join(" – ")]
          .filter(Boolean)
          .join("  |  ");
        if (line2) {
          children.push(new Paragraph({ children: [new TextRun(line2)] }));
        }
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

    const doc = new Document({
      sections: [
        {
          properties: {
            page: {
              margin: { top: 720, bottom: 720, left: 900, right: 900 }, // ~0.5–0.7"
            },
          },
          children,
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);
    const safeRole =
      (profile.targetTitle || "CV").replace(/[^a-z0-9]+/gi, "_") || "CV";
    const filename = `HireEdge_${safeRole}.docx`;

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
    console.error(err);
    res
      .status(400)
      .json({ error: "Failed to generate resume", details: String(err?.message || err) });
  }
}
