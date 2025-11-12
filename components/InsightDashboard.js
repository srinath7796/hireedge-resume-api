import { useMemo, useState } from 'react';
import styles from '../styles/Home.module.css';

const scenarios = [
  {
    role: 'Product Manager',
    narrative:
      'We instantly map your CV to the product roadmap expectations in the job post, highlighting market discovery depth and cross-functional delivery narratives.',
    matched: [
      'Roadmap ownership',
      'Stakeholder alignment',
      'Data-informed prioritisation',
      'Experimentation rituals',
    ],
    missing: ['Monetisation strategy', 'North-star KPI guardianship'],
  },
  {
    role: 'Senior Data Scientist',
    narrative:
      'HireEdge surfaces which modelling stories resonate with the posting, revealing coverage across MLOps hygiene, experimentation cadence, and decision impact.',
    matched: [
      'Model monitoring',
      'Cross-team enablement',
      'Experiment design',
      'Stakeholder storytelling',
    ],
    missing: ['Causal inference', 'Cost-to-serve optimisation'],
  },
  {
    role: 'Revenue Operations Lead',
    narrative:
      'We compare pipeline and retention levers against the JD to prove your GTM muscle and call out the RevOps rituals still to emphasise.',
    matched: [
      'Forecast governance',
      'Lifecycle instrumentation',
      'Salesforce automation',
      'CS collaboration',
    ],
    missing: ['Renewal playbooks', 'Enablement frameworks'],
  },
];

const keywordColor = (isMatch) => ({
  background: isMatch ? 'rgba(14, 116, 144, 0.12)' : 'rgba(244, 114, 182, 0.14)',
  color: isMatch ? '#0f766e' : '#be123c',
  borderRadius: '999px',
  padding: '10px 16px',
  fontWeight: 600,
  fontSize: '0.95rem',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
});

export function InsightDashboard() {
  const [activeIndex, setActiveIndex] = useState(0);

  const activeScenario = useMemo(() => scenarios[activeIndex], [activeIndex]);

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <h2>Role-Ready Insight Dashboard</h2>
          <p>
            Upload a CV and job post, and HireEdge instantly contrasts keyword momentum
            with the JD. Show the narrative summary alongside matched and missing
            signals so talent teams see the value before they download anything.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          {scenarios.map((scenario, index) => (
            <button
              key={scenario.role}
              type="button"
              onClick={() => setActiveIndex(index)}
              style={{
                border: 'none',
                cursor: 'pointer',
                borderRadius: '16px',
                padding: '10px 18px',
                fontWeight: 600,
                color: activeIndex === index ? '#f8fafc' : '#1e3a8a',
                background:
                  activeIndex === index
                    ? 'linear-gradient(135deg, #4338ca, #0ea5e9)'
                    : 'rgba(30, 64, 175, 0.14)',
                boxShadow:
                  activeIndex === index
                    ? '0 12px 30px rgba(14, 116, 144, 0.28)'
                    : 'none',
                transition: 'transform 0.2s ease',
              }}
            >
              {scenario.role}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.row}>
        <div
          style={{
            background: 'linear-gradient(135deg, rgba(30, 64, 175, 0.1), rgba(14, 116, 144, 0.1))',
            borderRadius: '24px',
            padding: '26px',
            border: '1px solid rgba(148, 163, 184, 0.25)',
            display: 'flex',
            flexDirection: 'column',
            gap: '18px',
          }}
        >
          <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#1e3a8a' }}>
            Narrative Summary
          </span>
          <p style={{ margin: 0, color: '#0f172a', lineHeight: 1.65 }}>{activeScenario.narrative}</p>
        </div>

        <div
          style={{
            background: '#0f172a',
            color: '#f8fafc',
            borderRadius: '24px',
            padding: '26px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            boxShadow: '0 24px 45px rgba(15, 23, 42, 0.4)',
          }}
        >
          <div>
            <h3 style={{ margin: '0 0 8px' }}>Matched Signals</h3>
            <p style={{ margin: 0, opacity: 0.8 }}>Stories already resonating with the JD.</p>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
            {activeScenario.matched.map((keyword) => (
              <span key={keyword} style={keywordColor(true)}>
                <span>✔</span>
                {keyword}
              </span>
            ))}
          </div>
          <div style={{ marginTop: '12px' }}>
            <h3 style={{ margin: '0 0 8px' }}>Opportunity Gaps</h3>
            <p style={{ margin: 0, opacity: 0.7 }}>Hints to weave into the tailored résumé.</p>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
            {activeScenario.missing.map((keyword) => (
              <span key={keyword} style={keywordColor(false)}>
                <span>●</span>
                {keyword}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
