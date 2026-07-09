const CATEGORY_LABELS: Record<string, string> = {
  "": "All",
  cricket: "Cricket",
  automobile: "Auto",
  technology: "Tech",
  general: "General",
};

interface NavbarProps {
  keyword: string;
  onKeywordChange: (val: string) => void;
  selectedCategory: string;
  onCategoryChange: (val: string) => void;
  selectedDate: string;
  onDateChange: (val: string) => void;
}

export default function Navbar({
  keyword,
  onKeywordChange,
  selectedCategory,
  onCategoryChange,
  selectedDate,
  onDateChange,
}: NavbarProps) {
  return (
    <nav className="bg-gray-900 text-white px-6 py-4 sticky top-0 z-50 shadow-lg">
      <div className="max-w-7xl mx-auto flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Nex<span className="text-blue-400">Brief</span>
          </h1>
          <a
            href="/status"
            className="text-xs px-3 py-1 rounded-full bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
          >
            Status
          </a>
        </div>

        <input
          type="date"
          value={selectedDate}
          max={new Date().toISOString().split("T")[0]}
          onChange={(e) => onDateChange(e.target.value)}
          className="bg-gray-800 text-white rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
        />

        <input
          type="text"
          placeholder="Search articles..."
          value={keyword}
          onChange={(e) => onKeywordChange(e.target.value)}
          className="bg-gray-800 text-white placeholder-gray-400 rounded-lg px-4 py-2 w-full md:w-72 focus:outline-none focus:ring-2 focus:ring-blue-400"
        />

        <div className="flex gap-2 flex-wrap">
          {Object.entries(CATEGORY_LABELS).map(([val, label]) => (
            <button
              key={val}
              onClick={() => onCategoryChange(val)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors
                ${
                  selectedCategory === val
                    ? "bg-blue-500 text-white"
                    : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}
