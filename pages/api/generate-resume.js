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
 * Very light CV text parser.
 * Goal: get *something* useful if user pasted old CV text.
 */
function parseOldCv(oldCvText = "") {
  const text = S(oldCvText);
  if (!text) return { exp: [], edu: [] };

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const exp = [];
  const edu = [];

  // simple regexes
  const dateLike = /(20\d{2}|19\d{2})/;
  const eduKeywords = /(BSc|BA|MA|MSc|MBA|Bachelor|Master|Diploma|University|College)/i;

  let currentExp = null;

  for (const line of lines) {
    // education line
    if (eduKeywords.test(line)) {
      edu.push({
        degree: line,
        institution: "",
        year: (line.match(dateLike) || [])[0] || "",
      });
      continue;
    }

    // bullet under current experience
    if ((line.startsWith("-") || line.startsWith("•")) && currentExp) {
      currentExp.bullets.push(line.replace(/^[-•]\s?/, "").trim());
      continue;
    }

    // line that looks like a job header (has date or " at ")
    if (dateLike.test(line) || / at /i.test(line)) {
      // close previous exp
      if (currentExp) exp.push(currentExp);

      currentExp = {
        title: line,
        company: "",
        location: "",
        start: "",
        end: "",
        bullets: [],
      };

      // try to split dates
      const rangeMatch = line.match(/(20\d{2}|19\d{2}).{0,3}[-–].{0,3}(20\d{2}|19\d{2}|Present|present)/);
      if (rangeMatch) {
        currentExp.start = rangeMatch[1];
        currentExp.end = rangeMatch[2];
      }

      continue;
    }

    // plain bullet style lines
    if ((line.startsWith("-") || line.startsWith("•")) && !currentExp) {
      // create a dummy exp to hold miscellaneous bullets
      currentExp = {
        title: "Relevant Experience",
        company: "",
        location: "",
        start: "",
        end: "",
        bullets: [line.replace(/^[-•]\s?/, "").trim()],
      };
      continue;
    }
  }

  // push last exp
  if (currentExp) exp.push(currentExp);

  return { exp, edu };
}

function normalize(body) {
  const jd = S(body.jd);
  const oldCvText = S(body.oldCvText || body.old_cv_text || body.oldCv);

  const profile = {
    fullName: S(body?.profile?.fullName || body?.fullName),
    targetTitle: S(body?.profile?.targetTitle || body?.targetTitle),
    email: S(body?.profile?.email || body?.email),
    phone: S(body?.profile?.phone || body?.phone),
    linkedin: S(body?.profile?.linkedin || body?.linkedin),
    yearsExp: S(body?.profile?.yearsExp || body?.yearsExp),
    topSkills: S(body?.profile?.topSkills || body?.topSkills),
  };

  // structured experience from form
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

  // structured education
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

  return { jd, oldCvText, profile, experiences, education };
}

const label = (txt) =>
  new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text: txt, bold: true })],
  });

const para = (txt) => new Paragraph({ children: [new TextRun(txt)] });
const bullet = (txt) =>
  new Paragraph({
    text: txt,
    bullet: { level: 0 },
  });

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
          spacing: { after: 240 },
          children: [new TextRun(contact.join("  |  "))],
        })
      );
    }

    // SUMMARY (uses JD + target role)
    children.push(label("PROFILE SUMMARY"));
    const sumParts = [];
    if (profile.targetTitle) {
      sumParts.push(`Targeting ${profile.targetTitle} roles`);
    } else {
      sumParts.push("Results-driven professional");
    }
    if (profile.yearsExp) {
      sumParts.push(`with ${profile.yearsExp} years' experience`);
    }
    if (jd) {
      sumParts.push("aligned to the provided job description");
    }
    children.push(para(sumParts.join(", ") + "."));

    // turn first few JD lines into bullets to match ATS
    if (jd) {
      const jdLines = jd
        .split(/\r?\n|\. /)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 4);
      jdLines.forEach((line) => children.push(bullet(line)));
    }

    // SKILLS
    if (profile.topSkills) {
      children.push(label("KEY SKILLS"));
      const skills = profile.topSkills
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
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

        const bullets = r.bullets && r.bullets.length ? r.bullets : [
          "Supported day-to-day operations and contributed to team outcomes.",
        ];
        bullets.forEach((b) => children.push(bullet(b)));
      });
    } else {
      children.push(
        para("Relevant experience can be supplied on request or added from your old CV.")
      );
    }

    // EDUCATION
    children.push(label("EDUCATION"));
    if (education.length) {
      education.forEach((e) => {
        const line = [e.degree, e.institution, e.year]
          .filter(Boolean)
          .join(", ");
        if (line) children.push(para(line));
      });
    } else {
      children.push(para("Education details available upon request."));
    }

    // DOC
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
