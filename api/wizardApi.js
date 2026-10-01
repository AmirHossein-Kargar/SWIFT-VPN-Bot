import axios from "axios";

// * Base URL for the Wizard API, loaded from environment variables
const BASE_URL = process.env.WIZARD_API_URL;

/**
 * * Create a new VPN service.
 * @param {number} gig - Amount of data in gigabytes.
 * @param {number} day - Number of days for the service.
 * @param {number} [test=0] - Set to 1 for test service, 0 for normal.
 * @returns {Promise<Object>} - API response data.
 */
export async function createVpnService(gig, day, test = 0) {
  try {
    // * Prepare form data
    const params = new URLSearchParams();
    params.append("gig", gig);
    params.append("day", day);
    params.append("test", test);

    // * Send POST request to create service
    const response = await axios.post(`${BASE_URL}/create`, params.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${process.env.VPN_API_KEY}`,
      },
    });

    return response.data;
  } catch (error) {
    // * If API returns an error response, return its data
    if (error.response) {
      return error.response.data;
    }
    // * Otherwise, throw the error
    throw error;
  }
}

/**
 * * Find a VPN service by username.
 * @param {string} username - The username of the service.
 * @returns {Promise<Object>} - API response data.
 */
export async function findService(username) {
  try {
    const params = new URLSearchParams();
    params.append("username", username);

    const response = await axios.post(
      `${BASE_URL}/find`,
      params.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${process.env.VPN_API_KEY}`,
        },
      }
    );

    if (response && response.data) {
      return response.data;
    } else {
      // Silent error: return undefined if no data
      return undefined;
    }
  } catch (error) {
    // Silent error: return undefined on any error
    return undefined;
  }
}

/**
 * * Create a test VPN service.
 * @returns {Promise<Object>} - API response data.
 */
export async function createTestService() {
  try {
    // * Prepare form data for test service
    const params = new URLSearchParams();
    params.append("test", "1");

    // * Send POST request to create test service
    const response = await axios.post(`${BASE_URL}/create`, params.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${process.env.VPN_API_KEY}`,
      },
    });

    return response.data;
  } catch (error) {
    // * If API returns an error response, return its data
    if (error.response) {
      return error.response.data;
    }
    throw error;
  }
}

/**
 * * Change the link for a VPN service.
 * @param {string} username - The username of the service.
 * @returns {Promise<Object>} - API response data.
 */
export async function changeLinkService(username) {
  try {
    // * Prepare form data
    const params = new URLSearchParams();
    params.append("username", username);

    // * Send POST request to change the service link
    const response = await axios.post(
      `${BASE_URL}/change_link`,
      params.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${process.env.VPN_API_KEY}`,
        },
      }
    );

    return response.data;
  } catch (error) {
    // * Log error details for debugging
    console.error("Error in changeLinkService:", error.message);
    if (error.response) {
      console.error("API Error response:", error.response.data);
      return error.response.data;
    }
    throw error;
  }
}

// * Delete Service

/**
 * * Delete a VPN service.
 * @param {string} username - The username of the service to delete.
 * @returns {Promise<Object>} - API response data.
 */
export async function deleteService(username) {
  try {
    // * Prepare form data
    const params = new URLSearchParams();
    params.append("username", username);

    // * Send POST request to delete the service
    const response = await axios.post(`${BASE_URL}/delsvc`, params.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${process.env.VPN_API_KEY}`,
      },
    });
    return response.data;
  } catch (error) {
    // * If API returns an error response, return its data
    if (error.response) {
      return error.response.data;
    }
    throw error;
  }
}

// * Deactivate Service

/**
 * * Deactivate (reverse mode) a VPN service.
 * @param {string} username - The username of the service to deactivate.
 * @returns {Promise<Object>} - API response data.
 */
export async function deactiveService(username) {
  try {
    // * Prepare form data
    const params = new URLSearchParams();
    params.append("username", username);

    // * Send POST request to deactivate the service
    const response = await axios.post(
      `${BASE_URL}/reverse_mode`,
      params.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${process.env.VPN_API_KEY}`,
        },
      }
    );
    return response.data;
  } catch (error) {
    // * If API returns an error response, return its data
    if (error.response) {
      return error.response.data;
    }
  }
}

// * Status
// NOTE: upgradeServiceTime / upgradeServiceData were removed — the bot UI
// intentionally disables plan extension ("این آپشن در حال حاضر غیرفعال است")
// and nothing in the codebase imported them.
export async function StatusApi() {
  try {
    const response = await axios.get(`${BASE_URL}/status`, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${process.env.VPN_API_KEY}`,
      },
    });
    return response.data;
  } catch (error) {
    if (error.response) {
      return error.response.data;
    }
    throw error;
  }
}
