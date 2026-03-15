
# Run this after creating https://github.com/augesrob/streamvibe-bridge on GitHub:
cd "C:\Temp\StreamVibe Bridge"
$env:GITHUB_TOKEN = [System.Environment]::GetEnvironmentVariable("GITHUB_TOKEN","User")
git remote set-url origin "https://$($env:GITHUB_TOKEN)@github.com/augesrob/streamvibe-bridge.git"
git push -u origin master 2>&1
