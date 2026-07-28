import { BridgeApp } from "./components/BridgeApp";
import {
  chatGPTSignInPath,
  chatGPTSignOutPath,
  getChatGPTUser,
} from "./chatgpt-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();
  const demoMode = process.env.NODE_ENV !== "production";

  return (
    <BridgeApp
      authorized={Boolean(user) || demoMode}
      demoMode={demoMode && !user}
      signInPath={chatGPTSignInPath("/")}
      signOutPath={chatGPTSignOutPath("/")}
    />
  );
}
