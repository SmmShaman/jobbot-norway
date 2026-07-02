import httpx, asyncio, re

async def check():
    job_id = "4390141785"
    url = f"https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{job_id}"
    async with httpx.AsyncClient() as client:
        r = await client.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        html = r.text
        print(f"Status: {r.status_code}, Length: {len(html)}")

        # Find ALL links
        links = re.findall(r'href="(https?://[^"]+)"', html)
        print(f"\nAll links ({len(links)}):")
        for l in links:
            print(f"  {l[:120]}")

        # Search for external apply
        if "halliburton" in html.lower():
            print("\nHALLIBURTON found in HTML!")
        else:
            print("\nhalliburton NOT in HTML")

        # Look for apply-related content
        apply_sections = re.findall(r'(apply[^<]{0,200})', html.lower())
        for s in apply_sections[:5]:
            print(f"  apply context: {s[:100]}")

        # Check if page says "Easy Apply" vs external
        if "easy apply" in html.lower():
            print("\nEASY APPLY detected")
        if "apply on company" in html.lower() or "apply on website" in html.lower():
            print("\nEXTERNAL APPLY detected")

asyncio.run(check())
