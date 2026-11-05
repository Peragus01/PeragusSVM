import { useEffect } from "react";
/** Progressive enhancement: content remains visible without JS or observer support. */
export function useReveal() {
  useEffect(() => {
    if (
      !window.IntersectionObserver ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(({ target, isIntersecting }) => {
          if (isIntersecting) {
            target.classList.add("is-revealed");
            observer.unobserve(target);
          }
        });
      },
      { threshold: 0.06 },
    );
    document.querySelectorAll(".public-section, .public-end").forEach((node) => {
      node.classList.add("reveal-ready");
      observer.observe(node);
    });
    return () => {
      observer.disconnect();
      document.querySelectorAll(".reveal-ready").forEach((n) => n.classList.remove("reveal-ready"));
    };
  }, []);
}
