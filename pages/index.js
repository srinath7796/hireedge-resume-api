import Head from 'next/head';
import styles from '../styles/Home.module.css';
import { InsightDashboard } from '../components/InsightDashboard';
import { OutreachKitPanel } from '../components/OutreachKitPanel';
import { ImpactHighlightsCarousel } from '../components/ImpactHighlightsCarousel';
import { FormatTransparencyPanel } from '../components/FormatTransparencyPanel';
import { OnboardingStepper } from '../components/OnboardingStepper';

export default function Home() {
  return (
    <div className={styles.page}>
      <Head>
        <title>HireEdge — Résumé intelligence that goes beyond formatting</title>
        <meta
          name="description"
          content="Showcase HireEdge’s insight-led résumé engine with keyword dashboards, outreach kits, impact highlights, and guided onboarding."
        />
      </Head>

      <main className={styles.inner}>
        <header className={styles.hero}>
          <div style={{ position: 'relative', zIndex: 1 }}>
            <h1>Turn every résumé into a role-ready growth plan.</h1>
            <p>
              HireEdge analyses CVs and job descriptions to craft tailored résumés,
              outreach kits, and quantified impact highlights. Bring those differentiators
              front-and-centre on the website to attract candidates and hiring teams alike.
            </p>
            <div className={styles.heroGrid}>
              <div className={styles.heroCard}>
                <span style={{ opacity: 0.7, letterSpacing: '0.6px', textTransform: 'uppercase' }}>
                  Insight depth
                </span>
                <strong style={{ fontSize: '1.8rem' }}>Keyword intelligence</strong>
                <p style={{ margin: 0, lineHeight: 1.6 }}>
                  Matched & missing JD signals visualised instantly for trust building.
                </p>
              </div>
              <div className={styles.heroCard}>
                <span style={{ opacity: 0.7, letterSpacing: '0.6px', textTransform: 'uppercase' }}>
                  Outreach ready
                </span>
                <strong style={{ fontSize: '1.8rem' }}>4-piece nurture kit</strong>
                <p style={{ margin: 0, lineHeight: 1.6 }}>
                  Email subject, pitch, LinkedIn note, and value hook generated on the fly.
                </p>
              </div>
              <div className={styles.heroCard}>
                <span style={{ opacity: 0.7, letterSpacing: '0.6px', textTransform: 'uppercase' }}>
                  Proof of impact
                </span>
                <strong style={{ fontSize: '1.8rem' }}>Quantified wins</strong>
                <p style={{ margin: 0, lineHeight: 1.6 }}>
                  Impact highlights ensure measurable achievements headline every résumé.
                </p>
              </div>
              <div className={styles.heroCard}>
                <span style={{ opacity: 0.7, letterSpacing: '0.6px', textTransform: 'uppercase' }}>
                  Flexible delivery
                </span>
                <strong style={{ fontSize: '1.8rem' }}>JSON & DOCX modes</strong>
                <p style={{ margin: 0, lineHeight: 1.6 }}>
                  Match the API’s preferences so clients choose downloads or insights.
                </p>
              </div>
            </div>
          </div>
        </header>

        <InsightDashboard />
        <OutreachKitPanel />
        <ImpactHighlightsCarousel />
        <FormatTransparencyPanel />
        <OnboardingStepper />
      </main>
    </div>
  );
}
