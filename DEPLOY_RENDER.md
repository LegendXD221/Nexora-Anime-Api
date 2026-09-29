# Render deployment

1. Upload/push this repository to GitHub.
2. In Render, choose **New + → Blueprint** and select the repository.
3. Render reads `render.yaml` and uses the Dockerfile.
4. Wait for the Docker build to finish.
5. Open the generated `onrender.com` URL.
6. Test `/health`, `/ready`, and `/api/watch?anilistId=21&episode=1&type=sub`.

The service uses one public port. Internal Kuhi, Anivexa, and anime-sdk services remain on loopback ports and are not exposed publicly.
