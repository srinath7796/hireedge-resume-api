import OpenAI from "openai";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import fs from "fs";
import path from "path";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function buildPrompt({ jd, profile }) {
  return `
You are an expert UK CV writer. Tailor the candidate’s CV to the job description.

Return strict JSON with keys:
summary (string 3–4 lines),
skills (array of 8–12 ATS keywords),
experience_blocks (array of roles),
education (array: { degree, institution, year }).

JOB DESCRIPTION:
${jd}

PROFILE:
${JSON.stringify(profile, null, 2)}
`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  try {
    const { jd, profile } = req.body || {};
    if (!jd || !profile?.fullName) {
      return res.status(400).json({ error: 'Missing jd or profile.fullName' });
    }

    // 1) Ask AI
    const prompt = buildPrompt({ jd, profile });
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You write ATS-optimised UK CVs." },
        { role: "user", content: prompt }
      ]
    });
    const data = JSON.parse(completion.choices[0].message.content);

    // 2) Map to template placeholders
    const mapped = {
      FULL_NAME: profile.fullName,
      JOB_TITLE: profile.targetTitle || "",
      EMAIL: profile.email || "",
      PHONE: profile.phone || "",
      LINKEDIN: profile.linkedin || "",
      SUMMARY: data.summary || "",
      SKILLS: (data.skills || []).join(" • "),
      EXPERIENCE_BLOCKS: (data.experience_blocks || [])
        .map(r => `\n${r.title} — ${r.company} (${r.start}–${r.end})\n- ${r.bullets.join("\n- ")}`)
        .join("\n\n"),
      EDUCATION: (data.education || [])
        .map(e => `${e.degree}, ${e.institution} (${e.year})`).join("\n")
    };

    // 3) Load template
    const templatePath = path.join(process.cwd(), "templates", "uk_modern_cv_template.docx");
    const content = fs.readFileSync(templatePath, "binary");
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
    doc.setData(mapped);
    doc.render();
    const buf = doc.getZip().generate({ type: "nodebuffer" });

    // 4) Send back file
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="HireEdge_CV.docx"');
    res.status(200).send(buf);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Resume generation failed' });
  }
}
