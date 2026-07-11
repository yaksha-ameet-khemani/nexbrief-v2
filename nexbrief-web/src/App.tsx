import Home from "./pages/Home";
import Status from "./pages/Status";
import SourceDetail from "./pages/SourceDetail";

function App() {
  const path = window.location.pathname;

  if (path === "/status") {
    return <Status />;
  }

  const sourceMatch = path.match(/^\/source\/([a-z0-9-]+)\/?$/);
  if (sourceMatch) {
    return <SourceDetail source={sourceMatch[1]} />;
  }

  return <Home />;
}

export default App;
