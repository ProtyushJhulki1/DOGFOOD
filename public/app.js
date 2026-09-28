(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function wrapSite() {
    if (document.querySelector('.site')) return;
    var fx = document.createElement('div');
    fx.className = 'fx-root';
    fx.setAttribute('aria-hidden', 'true');
    fx.innerHTML =
      '<div class="fx-aurora"></div>' +
      '<div class="fx-grid"></div>' +
      '<canvas class="fx-canvas"></canvas>' +
      '<div class="fx-vignette"></div>';
    if (!reduce) fx.innerHTML += '<div class="fx-scan"></div>';

    var site = document.createElement('div');
    site.className = 'site';
    while (document.body.firstChild) site.appendChild(document.body.firstChild);
    document.body.appendChild(fx);
    document.body.appendChild(site);
    return fx;
  }

  function particles(canvas) {
    if (!canvas || reduce) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var dots = [];
    var w = 0;
    var h = 0;
    var raf;

    function resize() {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
      var n = Math.min(70, Math.floor((w * h) / 18000));
      dots = [];
      for (var i = 0; i < n; i++) {
        dots.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: Math.random() * 1.6 + 0.4,
          vx: (Math.random() - 0.5) * 0.28,
          vy: (Math.random() - 0.5) * 0.28,
          a: Math.random() * 0.45 + 0.12
        });
      }
    }

    function tick() {
      ctx.clearRect(0, 0, w, h);
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i];
        d.x += d.vx;
        d.y += d.vy;
        if (d.x < 0 || d.x > w) d.vx *= -1;
        if (d.y < 0 || d.y > h) d.vy *= -1;
        ctx.beginPath();
        ctx.fillStyle = 'rgba(167,139,250,' + d.a + ')';
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      }
      for (var a = 0; a < dots.length; a++) {
        for (var b = a + 1; b < dots.length; b++) {
          var dx = dots[a].x - dots[b].x;
          var dy = dots[a].y - dots[b].y;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 110) {
            ctx.strokeStyle = 'rgba(167,139,250,' + (0.12 * (1 - dist / 110)) + ')';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(dots[a].x, dots[a].y);
            ctx.lineTo(dots[b].x, dots[b].y);
            ctx.stroke();
          }
        }
      }
      raf = requestAnimationFrame(tick);
    }

    resize();
    window.addEventListener('resize', resize);
    tick();
    return function () { cancelAnimationFrame(raf); };
  }

  function pointerGlow() {
    if (reduce) return;
    document.addEventListener('pointermove', function (e) {
      var cards = document.elementsFromPoint(e.clientX, e.clientY);
      for (var i = 0; i < cards.length; i++) {
        var el = cards[i].closest && cards[i].closest('.card, .stat, .login-box, .carousel, .role-btn');
        if (!el) continue;
        var r = el.getBoundingClientRect();
        el.style.setProperty('--mx', ((e.clientX - r.left) / r.width) * 100 + '%');
        el.style.setProperty('--my', ((e.clientY - r.top) / r.height) * 100 + '%');
      }
    }, { passive: true });
  }

  function reveals() {
    var nodes = document.querySelectorAll('.card, .stat, .login-box, table, .rung, .hero-inner, .page-title, .section-eyebrow');
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.add('reveal');
    if (reduce) {
      for (var j = 0; j < nodes.length; j++) nodes[j].classList.add('in');
      return;
    }
    if (!('IntersectionObserver' in window)) {
      for (var k = 0; k < nodes.length; k++) nodes[k].classList.add('in');
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -24px 0px' });
    for (var n = 0; n < nodes.length; n++) io.observe(nodes[n]);
  }

  function countUp() {
    var nums = document.querySelectorAll('[data-count]');
    if (!nums.length) return;
    function run(el) {
      var target = Number(el.getAttribute('data-count'));
      if (!isFinite(target)) return;
      if (reduce) { el.textContent = String(target); return; }
      var start = performance.now();
      var dur = 1100;
      function step(now) {
        var t = Math.min(1, (now - start) / dur);
        var eased = 1 - Math.pow(1 - t, 3);
        el.textContent = String(Math.round(target * eased));
        if (t < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }
    if (!('IntersectionObserver' in window)) {
      for (var i = 0; i < nums.length; i++) run(nums[i]);
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          run(entry.target);
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.4 });
    for (var j = 0; j < nums.length; j++) io.observe(nums[j]);
  }

  function carousel() {
    var track = document.getElementById('carouselTrack');
    var dotsWrap = document.getElementById('carouselDots');
    if (!track || !dotsWrap || dotsWrap.childElementCount) return;
    var slides = track.children;
    var current = 0;
    var timer;

    function goTo(i) {
      current = i;
      track.style.transform = 'translateX(-' + (i * 100) + '%)';
      Array.from(dotsWrap.children).forEach(function (d, idx) {
        d.classList.toggle('active', idx === i);
      });
    }

    for (var i = 0; i < slides.length; i++) {
      var dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'carousel-dot' + (i === 0 ? ' active' : '');
      dot.setAttribute('aria-label', 'Slide ' + (i + 1));
      (function (idx) {
        dot.addEventListener('click', function () { goTo(idx); restart(); });
      })(i);
      dotsWrap.appendChild(dot);
    }

    function restart() {
      if (reduce) return;
      clearInterval(timer);
      timer = setInterval(function () { goTo((current + 1) % slides.length); }, 4800);
    }

    var carouselEl = track.closest('.carousel');
    if (carouselEl) {
      carouselEl.addEventListener('mouseenter', function () { clearInterval(timer); });
      carouselEl.addEventListener('mouseleave', restart);
    }
    restart();
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.documentElement.classList.add('js');
    var fx = wrapSite();
    if (fx) particles(fx.querySelector('.fx-canvas'));
    pointerGlow();
    reveals();
    countUp();
    carousel();
  });
})();
