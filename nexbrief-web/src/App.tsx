import Home from "./pages/Home";
import Status from "./pages/Status";

function App() {
  if (window.location.pathname === "/status") {
    return <Status />;
  }
  return <Home />;
}

export default App;
