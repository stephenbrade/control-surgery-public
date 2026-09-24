(function () {
  "use strict";

  /* Only one <audio> element playing at a time (non-morph players). */
  document.querySelectorAll("audio").forEach(function (el) {
    el.addEventListener("play", function () {
      document.querySelectorAll("audio").forEach(function (other) {
        if (other !== el && !other.paused) other.pause();
      });
    });
  });

  /* Copy-to-clipboard for any [data-copy-target] block. */
  document.querySelectorAll("[data-copy-target]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var target = document.getElementById(btn.getAttribute("data-copy-target"));
      if (!target) return;
      navigator.clipboard.writeText(target.textContent).then(function () {
        var label = btn.textContent;
        btn.textContent = "Copied!";
        btn.classList.add("is-copied");
        setTimeout(function () {
          btn.textContent = label;
          btn.classList.remove("is-copied");
        }, 2000);
      });
    });
  });

  /* Hide the overview figure if the image has not been exported yet. */
  document.querySelectorAll(".figure-wrap img").forEach(function (img) {
    img.addEventListener("error", function () {
      var fig = img.closest(".figure-wrap");
      if (fig) fig.style.display = "none";
    });
  });
})();
