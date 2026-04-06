with open("packages/dashboard/src/pages/index.astro", "r", encoding="utf-8") as f:
    text = f.read()

text = text.replace("<span class='lang-zh'>", '<span class="lang-zh">')
text = text.replace("<span class='lang-en'>", '<span class="lang-en">')
text = text.replace("<span class='lang-zh block-lang'>", '<span class="lang-zh block-lang">')
text = text.replace("<span class='lang-en block-lang'>", '<span class="lang-en block-lang">')


with open("packages/dashboard/src/pages/index.astro", "w", encoding="utf-8") as f:
    f.write(text)
