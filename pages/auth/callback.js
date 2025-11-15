import { useEffect } from "react";
import { supabaseClient } from "../../lib/supabaseClient";

export default function CallbackPage() {
  useEffect(() => {
    const handleAuth = async () => {
      const { data } = await supabaseClient.auth.getSession();

      if (data?.session) {
        // Logged in success → go to dashboard
        window.location.href = "/dashboard";
      } else {
        // Something failed → send back to login
        window.location.href = "/login";
      }
    };

    handleAuth();
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#000",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      Finishing login...
    </div>
  );
}
