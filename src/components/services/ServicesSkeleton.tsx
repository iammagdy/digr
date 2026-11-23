export function ServicesSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-8" role="status" aria-label="جارٍ تحميل الكتالوج">
      <div className="h-12 w-full rounded-full bg-sf2" />
      <div className="flex gap-2">
        <div className="h-10 w-28 rounded-full bg-sf2" />
        <div className="h-10 w-32 rounded-full bg-sf2" />
        <div className="h-10 w-24 rounded-full bg-sf2" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="flex min-h-[220px] flex-col gap-3 rounded-[22px] border border-ln bg-sf p-5">
            <div className="h-6 w-3/4 rounded bg-sf2" />
            <div className="h-4 w-full rounded bg-sf2" />
            <div className="h-4 w-5/6 rounded bg-sf2" />
            <div className="mt-auto h-16 w-full rounded-[14px] bg-sf2/70" />
            <div className="flex items-center justify-between pt-2">
              <div className="h-4 w-20 rounded bg-sf2" />
              <div className="h-10 w-24 rounded-full bg-sf2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
