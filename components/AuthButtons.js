import { supabaseClient } from "../lib/supabaseClient";

export default function AuthButtons() {
  const signInWithGoogle = async () => {
    await supabaseClient.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
  };

  return (
    <button
      onClick={signInWithGoogle}
      style={{
        padding: "12px 16px",
        background: "#6C47FF",
        color: "#fff",
        borderRadius: "10px",
        border: "none",
        fontSize: "16px",
        cursor: "pointer",
      }}
    >
      Continue with Google
    </button>
  );
}
