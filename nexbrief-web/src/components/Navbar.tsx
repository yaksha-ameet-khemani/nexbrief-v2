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
    <nav className="bg-[#fffefa] text-[#1f1f1f] px-6 py-4 sticky top-0 z-50 border-b border-[#eaeaea]">
      <div className="max-w-7xl mx-auto flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl tracking-tight text-[#1f1f1f]">
            Nex<span className="text-[#cf412b]">Brief</span>
          </h1>
          <a
            href="/status"
            className="text-xs px-3 py-1 rounded-full bg-[#f5f5f5] text-[#6d6d6d] hover:bg-[#eaeaea] transition-colors"
          >
            Status
          </a>
        </div>

        <input
          type="date"
          value={selectedDate}
          max={new Date().toISOString().split("T")[0]}
          onChange={(e) => onDateChange(e.target.value)}
          className="bg-[#f5f5f5] text-[#1f1f1f] border border-[#eaeaea] rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-[#cf412b]/40"
        />

        <input
          type="text"
          placeholder="Search articles..."
          value={keyword}
          onChange={(e) => onKeywordChange(e.target.value)}
          className="bg-[#f5f5f5] text-[#1f1f1f] placeholder-[#6d6d6d] border border-[#eaeaea] rounded-lg px-4 py-2 w-full md:w-72 focus:outline-none focus:ring-2 focus:ring-[#cf412b]/40"
        />

        <div className="flex gap-2 flex-wrap">
          {Object.entries(CATEGORY_LABELS).map(([val, label]) => (
            <button
              key={val}
              onClick={() => onCategoryChange(val)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors
                ${
                  selectedCategory === val
                    ? "bg-[#cf412b] text-white"
                    : "bg-[#f5f5f5] text-[#3d3d3d] hover:bg-[#eaeaea]"
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
