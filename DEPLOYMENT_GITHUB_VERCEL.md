# GitHub & Vercel Deployment Guide

This guide explains how to deploy your frontend to Vercel using a GitHub repository. This method enables automatic deployments whenever you push changes to your repository.

## Prerequisites
- A GitHub account.
- A Vercel account (you can log in with GitHub).
- Git installed on your computer.

## Step 1: Prepare Your Local Repository

1.  **Initialize Git (if not already done):**
    Open your terminal in the project folder and run:
    ```bash
    git init
    ```

2.  **Check `.gitignore`:**
    Ensure you have a `.gitignore` file that excludes unnecessary files. Your current file looks good, but double-check it includes:
    ```
    node_modules/
    .env
    .vercel
    ```

3.  **Commit Your Changes:**
    Stage and commit all your files:
    ```bash
    git add .
    git commit -m "Initial commit: Ready for Vercel deployment"
    ```

## Step 2: Push to GitHub

1.  **Create a New Repository:**
    - Go to [GitHub.com](https://github.com) and sign in.
    - Click the **+** icon in the top right and select **New repository**.
    - Name it (e.g., `screen-share-frontend`).
    - Keep it **Public** or **Private** (Vercel works with both).
    - **Do not** initialize with README, .gitignore, or License (you already have them).
    - Click **Create repository**.

2.  **Push Local Code:**
    Copy the commands shown under "…or push an existing repository from the command line" and run them in your terminal. They will look like this:
    ```bash
    git remote add origin https://github.com/YOUR_USERNAME/screen-share-frontend.git
    git branch -M main
    git push -u origin main
    ```

## Step 3: Connect to Vercel

1.  **Go to Vercel Dashboard:**
    - Log in to [vercel.com](https://vercel.com).

2.  **Add New Project:**
    - Click **Add New...** > **Project**.
    - Select **Continue with GitHub**.

3.  **Import Repository:**
    - Find your `screen-share-frontend` repository in the list and click **Import**.

4.  **Configure Project:**
    - **Framework Preset:** Vercel should automatically detect it (or select "Other").
    - **Root Directory:** Leave as `./` (default).
    - **Build Command:** Leave empty (since we are serving static files).
    - **Output Directory:** Leave empty.
    - **Environment Variables:** You don't need any for the frontend (unless you want to hide the backend URL, but it's public in the JS anyway).

5.  **Deploy:**
    - Click **Deploy**.
    - Vercel will build your project and give you a live URL (e.g., `https://screen-share-frontend.vercel.app`).

## Step 4: Verify

- Open the provided URL.
- Test the Viewer and Broadcaster pages.
- Since your backend is on Hetzner (`yahya-sfu.duckdns.org`), the frontend should connect to it seamlessly.

## Future Updates

Whenever you want to update your site:
1.  Make changes locally.
2.  Commit and push:
    ```bash
    git add .
    git commit -m "Update message"
    git push
    ```
3.  Vercel will detect the push and automatically re-deploy your site!
