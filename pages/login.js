import AuthButtons from "../components/AuthButtons";

export default function Login() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "black",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "white",
      }}
    >
      <div
        style={{
          background: "#111",
          padding: "40px",
          borderRadius: "20px",
          width: "100%",
          maxWidth: "400px",
        }}
      >
        <h1 style={{ fontSize: "24px", marginBottom: "10px" }}>
          Sign in to HireEdge
        </h1>
        <p
          style={{
            fontSize: "14px",
            color: "#aaa",
            marginBottom: "20px",
          }}
        >
          Sign in to unlock your free HireEdge resume.
        </p>
        <AuthButtons />
      </div>
    </div>
  );
}
